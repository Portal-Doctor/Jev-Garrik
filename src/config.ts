const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
const num = (key: string) => (env(key) ? Number(env(key)) : undefined);

export const NATIVE_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

/** Horizons the Kuru resolver scores, in seconds. The first is the traded horizon (~horizonBlocks * 0.3 s). */
export const KURU_HORIZONS_SEC = [30, 300, 1800] as const;

export const config = {
  rpcUrl: env("RPC_URL", "https://rpc.monad.xyz")!, // sends, receipts, nonce, gas estimation
  readRpcUrl: env("READ_RPC_URL", "https://rpc.monad.xyz")!, // book reads + eth_blockNumber polling + trade logs
  wsUrl: env("WS_URL"), // optional; polling backstop always runs
  chainId: 143,
  market: env("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")!, // Kuru MON-USDC
  /** Kuru MarginAccount this market settles against (slot 73 of the OrderBook proxy; verifiedMarket(market) is true). */
  marginAccount: env("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5")!,
  /** Native Circle USDC on Monad (6 decimals). Confirm against market.quoteAssetAddress before a live deposit. */
  nativeUsdc: env("MONAD_USDC", NATIVE_USDC)!,
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true" || !env("PRIVATE_KEY"),
  /** Local engine is maker paper only. The tweet demo is not run here. */
  kuruMode: "maker" as const,
  tradeSizeMon: Number(env("TRADE_SIZE_MON", "200")), // Kuru MON-USDC minimum order is 200 MON
  maxPositionMon: Number(env("MAX_POSITION_MON", "36000")),
  /** Adverse mid move assumed when sizing a short so USDC can still buy it back. */
  shortCoverBuffer: Number(env("KURU_SHORT_COVER_BUFFER", "0.10")),
  bankrollUsd: Number(env("BANKROLL_USD", "100")), // used for pnlPct
  /** Quote this many ticks inside the touch (0 = join the best bid/ask). Never crosses: clamps to the touch when the spread is too tight. */
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** Maker mode: requote only when the touch moves more than this many ticks (vs last send, not last block). */
  requoteTicks: Number(env("KURU_REQUOTE_TICKS", "4")),
  /** Skip new quotes when the spread is tighter than this. Gas hurdle on a 200 MON clip is about 3 bps. */
  minSpreadBps: Number(env("KURU_MIN_SPREAD_BPS", "4")),
  /** Jev skew hysteresis: flip to buy at or above, hold last side in between. */
  buyThreshold: Number(env("KURU_BUY_THRESHOLD", "0.60")),
  /** Jev skew hysteresis: flip to sell at or below. */
  sellThreshold: Number(env("KURU_SELL_THRESHOLD", "0.40")),
  /** Stand aside when EMA fill markout is worse than minus this many bps. */
  markoutPullBps: Number(env("KURU_MARKOUT_PULL_BPS", "2")),
  /** Maker paper honesty: share of a crossing print we take (queue position is unknown). */
  fillHaircut: Number(env("KURU_FILL_HAIRCUT", "0.5")),
  /** Jev loop every N blocks. Quotes send on fill/touch, not on this tick. Default 3 (~900 ms). */
  decideBlocks: Number(env("KURU_DECIDE_BLOCKS", "3")),
  /** Optional overrides; unset means use the live market contract values. */
  makerFeeBps: num("KURU_MAKER_FEE_BPS"),
  takerFeeBps: num("KURU_TAKER_FEE_BPS"),
  /** Hard kill: no live send. Also trips if data/KILL exists. */
  kill: env("KURU_KILL") === "true",
  /** Live sends stop for the UTC day once realized + fees + gas drop this many USD. */
  dailyLossUsd: Number(env("KURU_DAILY_LOSS_USD", "15")),
  /** Promotion gate: minimum maker fills on this run. */
  gateMinFills: Number(env("KURU_GATE_MIN_FILLS", "200")),
  /** Same Postgres as cb/. Maker paper writes venue=kuru into the existing tables. */
  databaseUrl: env("DATABASE_URL", "postgres://cb:cb@localhost:5432/cb")!,
  /** Startup deposits into the Kuru margin account, topped up to these balances. Limit orders draw from margin, not the wallet. */
  marginMon: Number(env("MARGIN_MON", "36000")),
  marginUsdc: Number(env("MARGIN_USDC", "1000")),
  // Monad charges gas on the LIMIT, so never estimate per block: estimate once at init (or override) and hardcode.
  gasLimit: num("GAS_LIMIT"),
  gasLimitFallback: 350_000, // batchUpdate: one cancel + one post-only place measured at ~282k for the place alone
  // EIP-1559 type-2 only. Effective price = base + priority, so a high static cap is free.
  maxFeeGwei: Number(env("MAX_FEE_GWEI", "400")),
  priorityFeeGwei: Number(env("PRIORITY_FEE_GWEI", "2")), // Monad hardcodes eth_maxPriorityFeePerGas at 2
  pendingBlocks: 10, // give up on a tx with no receipt after this many blocks
  refreshBlocks: 200, // how often to refresh the fee estimate, margin balances and the vault check
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")), // the model is asked about the move over this many blocks (~30 s)
  model: env("MODEL", "mock") as "mock" | "jev",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  aiGatewayApiKey: env("AI_GATEWAY_API_KEY"),
  jevGatewayModelId: env("JEV_GATEWAY_MODEL_ID", "typesafe-ai/jev")!,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
};
