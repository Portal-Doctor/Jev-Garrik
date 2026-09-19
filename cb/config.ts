const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
const num = (key: string, fallback: number) => {
  const v = env(key);
  return v === undefined || v === "" ? fallback : Number(v);
};
const list = (key: string, fallback: string) =>
  (env(key, fallback) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The three horizons every decision is scored at (seconds). The middle one is the traded horizon. */
export const MEASURED_HORIZONS_SEC = [3600, 14400, 86400] as const;

export const config = {
  // Persistence: Postgres only (Bun.sql). Docker Compose serves this by default.
  databaseUrl: env("DATABASE_URL", "postgres://cb:cb@localhost:5432/cb")!,

  // Strategy (spec section 2). Pairs are config, not code.
  pairs: list("CB_PAIRS", "SOL-USD,DOGE-USD,SUI-USD,XRP-USD"),
  decideSec: num("CB_DECIDE_SEC", 300),
  horizonSec: num("CB_HORIZON_SEC", 14_400),
  notionalUsd: num("CB_NOTIONAL_USD", 1_000),
  bankrollUsd: num("CB_BANKROLL_USD", 10_000),

  // Fees and paper fill honesty knobs (spec sections 2.3, 6). Config, not hardcoded.
  makerFeeBps: num("CB_MAKER_FEE_BPS", 50),
  takerFeeBps: num("CB_TAKER_FEE_BPS", 90),
  fillHaircut: num("CB_FILL_HAIRCUT", 0.5),
  entryTimeoutSec: num("CB_ENTRY_TIMEOUT_SEC", 120),
  repriceTicks: num("CB_REPRICE_TICKS", 2),

  // Model (shared with the demo).
  model: (env("MODEL", "mock") as "mock" | "jev"),
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,

  // Coinbase Advanced Trade endpoints.
  coinbaseWsUrl: env("CB_WS_URL", "wss://advanced-trade-ws.coinbase.com")!,
  coinbaseRestUrl: env("CB_REST_URL", "https://api.coinbase.com")!,
  // CDP key, only needed for the user channel / live (M5). Market data is currently unauthenticated.
  apiKeyName: env("COINBASE_API_KEY_NAME"),
  apiPrivateKey: env("COINBASE_API_PRIVATE_KEY"),

  port: num("CB_PORT", 3001),
};

export type Config = typeof config;
