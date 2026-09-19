import { config, MEASURED_HORIZONS_SEC } from "./config";
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
});

const meta: RunMeta = {
  runId,
  mode: "paper",
  model: modelLabel,
  pairs: config.pairs,
  startedAt,
};

const feed = new Feed(config.pairs, store);
feed.start();

// Assigned once the server is up; broker/engine hooks push through it.
let broadcast: (type: string, data: unknown) => void = () => {};

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
  },
  (f) => {
    console.log(`FILL ${f.pair} ${f.side.toUpperCase()} ${f.purpose} ${f.sizeBase.toFixed(4)} @ ${f.price} ${f.liquidity} fee $${f.feeUsd.toFixed(4)}`);
    broadcast("fill", f);
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
  },
  broker,
  (id, decision, state, intent) => {
    console.log(`${state.pair} ${decision.action.toUpperCase()} pBuy=${(decision.pBuy * 100).toFixed(0)}% mid=${state.mid} ${Math.round(decision.latencyMs)}ms`);
    broadcast("decision", { id, pair: state.pair, action: decision.action, pBuy: decision.pBuy, mid: state.mid, ts: state.ts });
    if (intent) broadcast("order", intent);
  },
);
engine.start();

const resolver = new Resolver(store, MEASURED_HORIZONS_SEC, 60_000, (n) => console.log(`resolved ${n} outcome(s)`));
resolver.start();

const uptimeDays = () => Math.max((Date.now() - startedAt) / 86_400_000, 1 / 1440); // floor at one minute
const srv = startServer({
  meta,
  store,
  snapshot: () => ({
    pairs: feed.allState(),
    positions: broker.allState(),
    decisions: [...engine.latest.entries()].map(([pair, v]) => ({ pair, action: v.decision.action, pBuy: v.decision.pBuy, mid: v.state.mid })),
  }),
  incidentsPerDay: () => feed.incidents / uptimeDays(),
});
broadcast = srv.broadcast;
const server = srv.server;

// Live streams for the dashboard: per-second ticks and per-minute equity.
const tickTimer = setInterval(
  () => broadcast("tick", feed.allState().map((s) => ({ pair: s.pair, mid: s.mid, spreadBps: s.spreadBps }))),
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

console.log(
  `cb paper trader | run ${runId} | model=${meta.model} | pairs=${config.pairs.join(",")} | db=${config.databaseUrl.replace(/:[^:@/]*@/, ":****@")} | http://localhost:${server.port}`,
);
