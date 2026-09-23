import { config, MEASURED_HORIZONS_SEC } from "./config";
import { assertTakeProfitClearsFees } from "./gate";

assertTakeProfitClearsFees(config.takeProfitBps, config.makerFeeBps, config.takerFeeBps);
import { Store } from "./db/store";
import { Feed } from "./feed";
import { createModel } from "./model";
import { Engine } from "./engine";
import { PaperBroker } from "./paper";
import { Resolver } from "./resolver";
import { startServer, type RunMeta } from "./server";

/**
 * Bootstrap: config, store, feed, paper broker, engine, resolver, server. Wires the live SSE
 * broadcasts (tick / decision / fill / equity) the /paper dashboard consumes.
 */

const gitSha = await (async () => {
  try {
    return (await Bun.$`git rev-parse --short HEAD`.text()).trim() || null;
  } catch {
    return null;
  }
})();

const store = new Store(config.databaseUrl);
await store.init();

const runId = crypto.randomUUID();
const startedAt = Date.now();
// Label reflects the actual Jev transport: the Gateway model id when routing through Vercel.
const modelLabel = config.model === "jev" ? (config.aiGatewayApiKey ? config.jevGatewayModelId : config.jevModelId) : "mock";
await store.insertRun({
  id: runId,
  mode: "paper",
  model: modelLabel,
  pairs: config.pairs.join(","),
  config,
  git_sha: gitSha,
  started_at: startedAt,
  venue: "paper",
});

const meta: RunMeta = {
  runId,
  mode: "paper",
  model: modelLabel,
  pairs: config.pairs,
  startedAt,
  decideSec: config.decideSec,
};

const feed = new Feed(config.pairs, store);
feed.start();

// Assigned once the server is up; broker/engine hooks push through it.
let broadcast: (type: string, data: unknown) => void = () => {};
// Assigned once `shutdown` exists below; the /reset route needs a reference before that point.
let doReset: () => Promise<void> = async () => {};

const model = createModel();
const broker = new PaperBroker(
  config.pairs,
  feed,
  store,
  runId,
  {
    notionalUsd: config.notionalUsd,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    fillHaircut: config.fillHaircut,
    entryTimeoutSec: config.entryTimeoutSec,
    repriceTicks: config.repriceTicks,
    horizonSec: config.horizonSec,
    bankrollUsd: config.bankrollUsd,
    neverCrossEntry: config.neverCrossEntry,
    stopLossBps: config.stopLossBps,
    takeProfitBps: config.takeProfitBps,
    maxSlippageBps: config.maxSlippageBps,
    feedHealthy: (pair) => feed.feedHealthy(pair),
  },
  (f) => {
    console.log(`FILL ${f.pair} ${f.side.toUpperCase()} ${f.purpose} ${f.sizeBase.toFixed(4)} @ ${f.price} ${f.liquidity} fee $${f.feeUsd.toFixed(4)}`);
    broadcast("fill", f);
    broadcast("equity", broker.allState());
  },
);
await broker.start(config.coinbaseRestUrl);

const engine = new Engine(
  config.pairs,
  feed,
  model,
  store,
  runId,
  {
    decideSec: config.decideSec,
    horizonSec: config.horizonSec,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    jevUsdPerMTok: config.jevUsdPerMTok,
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    feeBuffer: config.feeBuffer,
    notionalUsd: config.notionalUsd,
    depthParticipation: config.depthParticipation,
    minSizeUsd: config.minSizeUsd,
  },
  broker,
  (id, decision, state, intent) => {
    const gate = decision.gate;
    const label = gate.approved ? "approved" : (gate.reason ?? "hold");
    console.log(`${state.pair} ${decision.action.toUpperCase()} pBuy=${(decision.pBuy * 100).toFixed(0)}% ${decision.vector.market_regime} ${label} mid=${state.mid} ${Math.round(decision.latencyMs)}ms`);
    broadcast("decision", {
      id,
      pair: state.pair,
      action: decision.action,
      pBuy: decision.pBuy,
      mid: state.mid,
      ts: state.ts,
      nextTs: engine.nextDecisionAt(state.pair),
      regime: decision.vector.market_regime,
      toxic: decision.vector.toxic_flow_risk,
      approved: gate.approved,
      reason: gate.reason,
      hurdleBps: gate.hurdleBps,
    });
    if (intent) broadcast("order", intent);
  },
);
engine.start();

const resolver = new Resolver(store, MEASURED_HORIZONS_SEC, 60_000, (n) => console.log(`resolved ${n} outcome(s)`));
resolver.start();

const uptimeDays = () => Math.max((Date.now() - startedAt) / 86_400_000, 1 / 1440); // floor at one minute
/** Bid and ask share of the top of book. Moves on every quote heartbeat. */
const bookSides = (pair: string) => {
  const imb = feed.featureSnapshot(pair, config.horizonSec).imbalance5;
  const buy = Math.round(Math.min(1, Math.max(0, (imb + 1) / 2)) * 1000) / 1000;
  return { buy, sell: Math.round((1 - buy) * 1000) / 1000 };
};

const srv = startServer({
  meta,
  store,
  snapshot: async () => {
    const [rows, fills] = await Promise.all([
      store.recentDecisions({ limit: 50, venue: "paper" }),
      store.recentFillsJoined(50),
    ]);
    const live = new Set(config.pairs);
    return {
      pairs: feed.allState().map((s) => ({ ...s, ...bookSides(s.pair) })),
      positions: broker.allState(),
      decisions: [...engine.latest.entries()].map(([pair, v]) => ({
        pair,
        action: v.decision.action,
        pBuy: v.decision.pBuy,
        mid: v.state.mid,
        regime: v.decision.vector.market_regime,
        toxic: v.decision.vector.toxic_flow_risk,
        approved: v.decision.gate.approved,
        reason: v.decision.gate.reason,
        hurdleBps: v.decision.gate.hurdleBps,
      })),
      nextDecision: Object.fromEntries(config.pairs.map((p) => [p, engine.nextDecisionAt(p)])),
      recentDecisions: rows.filter((d) => live.has(d.pair)).map((d) => ({
        id: d.id,
        pair: d.pair,
        action: d.action,
        pBuy: Number(d.p_buy),
        mid: Number(d.mid),
        ts: Number(d.ts),
      })),
      recentFills: fills.filter((f) => live.has(f.pair)).map((f) => ({
        pair: f.pair,
        side: f.side,
        purpose: f.purpose === "stop" || f.purpose === "take_profit" || f.purpose === "entry" || f.purpose === "exit" ? f.purpose : f.side === "buy" ? "entry" : "exit",
        price: Number(f.price),
        sizeBase: Number(f.size_base),
        feeUsd: Number(f.fee_usd),
        liquidity: f.liquidity,
        ts: Number(f.traded_at),
      })),
    };
  },
  incidentsPerDay: () => feed.incidents / uptimeDays(),
  reset: () => doReset(),
});
broadcast = srv.broadcast;
const server = srv.server;

// Live streams for the dashboard: per-second ticks and per-minute equity.
const tickTimer = setInterval(
  () =>
    broadcast("tick", {
      ticks: feed.allState().map((s) => ({ pair: s.pair, mid: s.mid, spreadBps: s.spreadBps, ...bookSides(s.pair) })),
      nextDecision: Object.fromEntries(config.pairs.map((p) => [p, engine.nextDecisionAt(p)])),
    }),
  1_000,
);
const equityTimer = setInterval(() => broadcast("equity", broker.allState()), 60_000);

const shutdown = async () => {
  try {
    clearInterval(tickTimer);
    clearInterval(equityTimer);
    engine.stop();
    resolver.stop();
    broker.stop();
    feed.stop();
    await store.stopRun(runId, Date.now());
    await store.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Admin "clear paper trades": wipe Coinbase venue rows only, then exit so Docker
// `restart: unless-stopped` brings up a fresh process. Kuru rows stay put.
doReset = async () => {
  await store.resetVenue("paper");
  setTimeout(() => void shutdown(), 250);
};

console.log(
  `cb paper trader | run ${runId} | model=${meta.model} | pairs=${config.pairs.join(",")} | db=${config.databaseUrl.replace(/:[^:@/]*@/, ":****@")} | http://localhost:${server.port}`,
);
