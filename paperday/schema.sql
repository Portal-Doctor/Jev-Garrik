-- Paper-day store. Own database, not cb. Bound to 127.0.0.1 by compose.
-- Keys are idempotent. Writers insert ... on conflict do nothing.

CREATE TABLE IF NOT EXISTS bars (
  key TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_ts BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_snapshots (
  key TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_ts BIGINT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS bias_checks (
  key TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  open_ts BIGINT NOT NULL,
  known BOOLEAN NOT NULL,
  up BOOLEAN NOT NULL,
  ema DOUBLE PRECISION,
  last_close DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS sentiment_checks (
  key TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  as_of BIGINT NOT NULL,
  sentiment TEXT NOT NULL,
  post_ids JSONB NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  key TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  setup TEXT NOT NULL,
  bar_ts BIGINT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS jev_reviews (
  key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  verdict TEXT,
  rank_score DOUBLE PRECISION,
  labels JSONB,
  rationale TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_usd DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL,
  jev_stage_at_time INTEGER NOT NULL,
  applied BOOLEAN NOT NULL,
  month TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS override_checks (
  key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  as_of BIGINT NOT NULL,
  pass BOOLEAN NOT NULL,
  failed JSONB NOT NULL,
  checks JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS allocations (
  key TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  ok BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  total DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  take BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  notional DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS paper_fills (
  key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  pair TEXT NOT NULL,
  ts BIGINT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  units DOUBLE PRECISION NOT NULL,
  fee_usd DOUBLE PRECISION NOT NULL,
  fee_bps DOUBLE PRECISION NOT NULL,
  liquidity TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  key TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  pair TEXT NOT NULL,
  closed_ts BIGINT NOT NULL,
  reason TEXT NOT NULL,
  net_usd DOUBLE PRECISION NOT NULL,
  r_multiple DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  key TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  window_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  formula TEXT NOT NULL,
  from_ts BIGINT NOT NULL,
  to_ts BIGINT NOT NULL,
  data_hash TEXT NOT NULL,
  fee_tier TEXT NOT NULL,
  net_usd DOUBLE PRECISION,
  max_drawdown_usd DOUBLE PRECISION,
  pass BOOLEAN,
  results JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS jev_scorecard (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_summary (
  key TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS quarter_tracker (
  key TEXT PRIMARY KEY,
  quarter TEXT NOT NULL,
  net_usd DOUBLE PRECISION NOT NULL,
  goal_usd DOUBLE PRECISION NOT NULL,
  pass BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS run_manifest (
  key TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
