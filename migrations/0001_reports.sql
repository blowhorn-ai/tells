-- The reports catalog (blowhorn-ai/tells#106, #108). One redacted row per visitor run.
CREATE TABLE IF NOT EXISTS reports (
  run_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  received_day TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  schema_version INTEGER,
  catalog_version TEXT,
  score INTEGER,
  classification TEXT,
  risk TEXT,
  reasons TEXT NOT NULL,
  detections TEXT NOT NULL,
  ua_family TEXT,
  os_family TEXT,
  country TEXT,
  asn_class TEXT,
  interaction_completed INTEGER NOT NULL DEFAULT 0,
  -- 0 waiting for the hourly compaction, 1 aggregated (and exported to R2 when the mode allows)
  state INTEGER NOT NULL DEFAULT 0
);
-- Only waiting rows are indexed, so the hourly job never scans the table. No other secondary index:
-- each index row counts against the D1 free write allowance.
CREATE INDEX IF NOT EXISTS reports_pending_idx ON reports (state) WHERE state = 0;

-- One row per UTC day. Never pruned: the sum of accepted is the monotonic total of reports collected.
-- Rows held now = accepted - counted (counted only, no row) - removed (visitor request) - pruned (retention).
CREATE TABLE IF NOT EXISTS ledger (
  period TEXT PRIMARY KEY,
  accepted INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  pruned INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0,
  r2_puts INTEGER NOT NULL DEFAULT 0,
  r2_bytes INTEGER NOT NULL DEFAULT 0
);

-- Small key/value state, for example raw_held_bytes (bytes now held in R2).
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);

-- One row per hourly R2 object, so pruning never needs an R2 list call.
CREATE TABLE IF NOT EXISTS raw_objects (
  key TEXT PRIMARY KEY,
  hour TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reports INTEGER NOT NULL
);

-- Aggregates, kept forever. dim names the figure, k its key, n the count for the day.
CREATE TABLE IF NOT EXISTS agg_counts (
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  k TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, k)
) WITHOUT ROWID;
