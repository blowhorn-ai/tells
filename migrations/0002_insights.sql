-- Precomputed insight payloads (blowhorn-ai/tells#107). One row per window, rebuilt from agg_counts at most every
-- six hours by the scheduled job. Requests read one row; they never scan agg_counts.
CREATE TABLE IF NOT EXISTS insights_snapshot (
  window INTEGER PRIMARY KEY,
  built_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
