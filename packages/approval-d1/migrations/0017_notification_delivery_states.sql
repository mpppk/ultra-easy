-- #94: notification delivery reliability.
-- * outbox dispatch failures back off via next_attempt_at and become 'dead' after the
--   retry limit (or when the queue consumer gives up and the message lands in the DLQ).
-- * a delivery / outbox entry the sink skipped (no Slack secret yet) is 'skipped', never
--   'sent', so it can be re-queued once the sink is configured.
ALTER TABLE outbox_events ADD COLUMN next_attempt_at TEXT;

CREATE INDEX outbox_events_retry_idx
  ON outbox_events (status, next_attempt_at, sequence);
