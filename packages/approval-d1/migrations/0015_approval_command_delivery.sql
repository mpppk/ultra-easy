-- #79 / #88: Decision command delivery semantics.
-- * status gains 'delivered' (sent to the Workflow, business outcome not yet known);
--   the Workflow moves it to applied / rejected with a compare-and-set update.
-- * retriable delivery failures stay 'pending' with attempt_count / next_attempt_at
--   backoff instead of becoming a terminal 'failed'.
-- * lease_until prevents the inline processor and the cron sweep from delivering
--   the same pending command concurrently.
ALTER TABLE approval_commands ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approval_commands ADD COLUMN next_attempt_at TEXT;
ALTER TABLE approval_commands ADD COLUMN lease_until TEXT;

CREATE INDEX approval_commands_due_idx
  ON approval_commands (status, next_attempt_at, created_at);
