-- Coinbase paper-trading store. Postgres only (Bun.sql).
-- Applied on boot with CREATE TABLE IF NOT EXISTS; additive migrations only.
-- Types: TEXT ids (crypto.randomUUID), BIGINT epoch ms, DOUBLE PRECISION money/size,
-- BOOLEAN flags, JSONB for config/state/raw.

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,               -- paper | live
  model TEXT NOT NULL,              -- mock | jev model id
  pairs TEXT NOT NULL,              -- comma separated
  config JSONB NOT NULL,            -- full config at start (fee bps, haircut, sizes)
  git_sha TEXT,
  started_at BIGINT NOT NULL,
  stopped_at BIGINT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  pair TEXT NOT NULL,
  ts BIGINT NOT NULL,
  action TEXT NOT NULL,             -- buy | sell
  p_buy DOUBLE PRECISION NOT NULL,
  p_sell DOUBLE PRECISION NOT NULL,
  mid DOUBLE PRECISION NOT NULL,
  spread_bps DOUBLE PRECISION NOT NULL,
  state JSONB NOT NULL,             -- MarketState as given to the model
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  inference_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  traded BOOLEAN NOT NULL DEFAULT FALSE   -- true if it changed the target position
);
CREATE INDEX IF NOT EXISTS idx_decisions_pair_ts ON decisions(pair, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_run ON decisions(run_id);

-- One row per (decision, measured horizon). Written by the resolver when ts + horizon passes.
CREATE TABLE IF NOT EXISTS outcomes (
  decision_id TEXT NOT NULL,
  horizon_sec INTEGER NOT NULL,     -- 3600 | 14400 | 86400
  resolved_at BIGINT NOT NULL,
  mid_then DOUBLE PRECISION NOT NULL,
  mid_at_horizon DOUBLE PRECISION NOT NULL,
  move_bps DOUBLE PRECISION NOT NULL,   -- signed, from decision mid
  correct BOOLEAN NOT NULL,             -- sign(move) matched the call
  PRIMARY KEY (decision_id, horizon_sec)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  decision_id TEXT,
  pair TEXT NOT NULL,
  side TEXT NOT NULL,               -- buy | sell
  purpose TEXT NOT NULL,            -- entry | exit
  price DOUBLE PRECISION NOT NULL,
  size_base DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL,             -- open | filled | partial | canceled | converted_taker | expired
  venue_order_id TEXT,              -- null in paper mode
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders(pair, status);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  order_id TEXT,
  venue TEXT NOT NULL,              -- paper | coinbase
  external_id TEXT NOT NULL,        -- synthetic in paper, venue trade id live
  pair TEXT NOT NULL,
  side TEXT NOT NULL,               -- buy | sell
  price DOUBLE PRECISION NOT NULL,
  size_base DOUBLE PRECISION NOT NULL,
  notional_usd DOUBLE PRECISION NOT NULL,
  fee_usd DOUBLE PRECISION NOT NULL,
  liquidity TEXT NOT NULL,          -- maker | taker
  cost_basis_usd DOUBLE PRECISION NOT NULL,   -- buys: notional + fee, else 0
  proceeds_usd DOUBLE PRECISION NOT NULL,     -- sells: notional - fee, else 0
  source TEXT NOT NULL,             -- paper_sim | coinbase_sync
  traded_at BIGINT NOT NULL,
  recorded_at BIGINT NOT NULL,
  raw JSONB,
  UNIQUE (venue, external_id)
);
CREATE INDEX IF NOT EXISTS idx_fills_pair_traded ON fills(pair, traded_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  pair TEXT NOT NULL,               -- pair or TOTAL
  ts BIGINT NOT NULL,
  mid DOUBLE PRECISION,
  position_base DOUBLE PRECISION NOT NULL,
  entry_price DOUBLE PRECISION,
  realized_usd DOUBLE PRECISION NOT NULL,
  unrealized_usd DOUBLE PRECISION NOT NULL,
  fees_usd DOUBLE PRECISION NOT NULL,
  inference_usd DOUBLE PRECISION NOT NULL,
  equity_usd DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pair_ts ON snapshots(pair, ts);

-- Minute bars so the resolver and charts survive restarts.
CREATE TABLE IF NOT EXISTS bars (
  pair TEXT NOT NULL,
  ts BIGINT NOT NULL,               -- minute start (epoch ms)
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume_base DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (pair, ts)
);
