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
  // AVAX supplements the original four. TAO was dropped after repeated Jev 429s.
  pairs: list("CB_PAIRS", "SOL-USD,DOGE-USD,SUI-USD,XRP-USD,AVAX-USD"),
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
  // If true, an entry that is unfilled at the maker touch after entryTimeoutSec is canceled
  // instead of converted to a taker fill (PL-REVENUE-REVIEW.md 3.4): a missed entry costs
  // nothing, a taker entry costs the whole per-trade edge.
  neverCrossEntry: (env("CB_NEVER_CROSS_ENTRY", "true") ?? "true").toLowerCase() === "true",
  /** Hard halt: no new entries. Flatten still allowed. Also trips if data/CB_KILL exists. */
  kill: (env("CB_KILL", "false") ?? "false").toLowerCase() === "true",
  /** UTC-day realized P and L (including fees) that trips the kill switch. */
  dailyLossUsd: num("CB_DAILY_LOSS_USD", 1500),

  // Decision hysteresis (PL-REVENUE-REVIEW.md 3.2): only act on the model's call when it clears a
  // confidence band wide enough to beat the round-trip fee cost, converting a raw buy/sell flip
  // into fewer, higher-conviction round trips. Holding position when p(buy) is between the two.
  buyThreshold: num("CB_BUY_THRESHOLD", 0.6),
  sellThreshold: num("CB_SELL_THRESHOLD", 0.4),

  // Model (shared with the demo).
  model: (env("MODEL", "mock") as "mock" | "jev"),
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  // Vercel AI Gateway: when AI_GATEWAY_API_KEY is set, the Jev model routes through the Gateway using
  // the string model id below (no direct TypeSafe key / waitlist needed). Otherwise it uses the direct
  // TypeSafe provider with TYPESAFE_AI_API_KEY.
  aiGatewayApiKey: env("AI_GATEWAY_API_KEY"),
  jevGatewayModelId: env("JEV_GATEWAY_MODEL_ID", "typesafe-ai/jev")!,

  // Coinbase Advanced Trade endpoints.
  coinbaseWsUrl: env("CB_WS_URL", "wss://advanced-trade-ws.coinbase.com")!,
  coinbaseRestUrl: env("CB_REST_URL", "https://api.coinbase.com")!,
  // CDP key, only needed for the user channel / live (M5). Market data is currently unauthenticated.
  apiKeyName: env("COINBASE_API_KEY_NAME"),
  apiPrivateKey: env("COINBASE_API_PRIVATE_KEY"),

  // Prefer the platform-injected PORT (Railway/Render/Fly) so the service is reachable when hosted,
  // then CB_PORT for local overrides, then the default.
  port: num("PORT", num("CB_PORT", 3001)),
};

export type Config = typeof config;
