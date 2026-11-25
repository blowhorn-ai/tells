-- The reports catalog (blowhorn-ai/tells#106). One redacted row per visitor run; see src/report-catalog.js.
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
  interaction_completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reports_expires_idx ON reports (expires_at);
CREATE INDEX IF NOT EXISTS reports_day_idx ON reports (received_day);
