import { config, KURU_HORIZONS_SEC } from "./config";
import { rpcIncidents, startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";
import { Store } from "../cb/db/store";
import { Resolver } from "../cb/resolver";
import { KuruLedger } from "./ledger";
import { buildKuruReport } from "./report";
import { buildTaxFromStore } from "../cb/tax";
import { coinbaseRefMid, divergenceBps } from "./refprice";

const market = new Market();
await market.init();
const model = createModel();

const gitSha = await (async () => {
  try { return (await Bun.$`git rev-parse --short HEAD`.text()).trim() || null; } catch { return null; }
})();

const startedAt = Date.now();
const store = new Store(config.databaseUrl);
const runId = crypto.randomUUID();
if (store) {
  await store.init();
  await store.insertRun({
    id: runId,
    mode: config.dryRun ? "paper" : "live",
    model: model.name,
    pairs: "MON-USDC",
    config,
    git_sha: gitSha,
    started_at: startedAt,
    venue: "kuru",
  });
}

const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
  },
);

if (store) trader.attachLedger(new KuruLedger(store, runId, trader.acct));
trader.attachTradeFeed(log10(market.params.sizePrecision));

const resolver = store
  ? new Resolver(store, KURU_HORIZONS_SEC, 10_000, (n) => console.log(`resolved ${n} outcome(s)`), { pair: "MON-USDC", runId })
  : null;
resolver?.start();

const uptimeDays = () => Math.max((Date.now() - startedAt) / 86_400_000, 1 / 1440);
let doReset: () => Promise<void> = async () => {};
const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt, kuruMode: config.kuruMode, runId: store ? runId : undefined },
  () => trader.history,
  {
    report: store
      ? () => buildKuruReport(store, {
          runId,
          incidentsPerDay: rpcIncidents.count / uptimeDays(),
          makerFeeBps: market.makerFeeBps,
          takerFeeBps: market.takerFeeBps,
        })
      : undefined,
    tax: store ? () => buildTaxFromStore(store, "kuru") : undefined,
    reset: () => doReset(),
    latest: () => trader.latest,
    activity: () => trader.activity,
  },
);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Wipe Kuru rows, then exit so Docker `restart: unless-stopped` brings up a fresh run.
doReset = async () => {
  if (store) await store.resetVenue("kuru");
  setTimeout(() => void shutdown(), 250);
};

async function shutdown() {
  try {
    resolver?.stop();
    await store?.stopRun(runId, Date.now());
    await store?.close();
  } finally {
    process.exit(0);
  }
}

const mode = `maker two-sided requote>${config.requoteTicks} ticks haircut ${config.fillHaircut}`;
setInterval(() => {
  const mid = trader.latest?.mid;
  if (!mid) return;
  void coinbaseRefMid().then((ref) => {
    if (ref == null) return;
    console.log(`ref MON-USD ${ref.toFixed(6)} kuru ${mid.toFixed(6)} div ${divergenceBps(mid, ref).toFixed(1)} bps`);
  });
}, 60_000);

console.log(`jev-trader · mode=${config.kuruMode} · ${mode} · model=${model.name} · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · read ${config.readRpcUrl} · :${config.port}`);
startBlockFeed((block) => trader.onBlock(block));
