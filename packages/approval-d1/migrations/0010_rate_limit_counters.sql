CREATE TABLE IF NOT EXISTS rate_limit_counters (
  scope_key TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  reset_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_key, window_start_ms)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_reset_at
  ON rate_limit_counters (reset_at_ms);
