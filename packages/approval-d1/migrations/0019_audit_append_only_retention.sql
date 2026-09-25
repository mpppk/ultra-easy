-- #99: append-only audit enforced by the database, and retention indexes.
-- action_events / force_cancel_audit are the audit trail: never updated or deleted by the
-- application (same rule as authorization_relationship_events in 0012). Operational tables
-- are purged by the cron (`purgeExpiredOperationalData`, docs/data-retention.md).
CREATE TRIGGER action_events_no_update
  BEFORE UPDATE ON action_events
BEGIN
  SELECT RAISE(ABORT, 'action_events is append-only');
END;

CREATE TRIGGER action_events_no_delete
  BEFORE DELETE ON action_events
BEGIN
  SELECT RAISE(ABORT, 'action_events is append-only');
END;

CREATE TRIGGER force_cancel_audit_no_update
  BEFORE UPDATE ON force_cancel_audit
BEGIN
  SELECT RAISE(ABORT, 'force_cancel_audit is append-only');
END;

CREATE TRIGGER force_cancel_audit_no_delete
  BEFORE DELETE ON force_cancel_audit
BEGIN
  SELECT RAISE(ABORT, 'force_cancel_audit is append-only');
END;

CREATE INDEX IF NOT EXISTS api_idempotency_retention_idx
  ON api_idempotency_keys (status, updated_at);

CREATE INDEX IF NOT EXISTS approval_commands_retention_idx
  ON approval_commands (status, created_at);

CREATE INDEX IF NOT EXISTS outbox_events_retention_idx
  ON outbox_events (status, created_at);

CREATE INDEX IF NOT EXISTS notification_deliveries_retention_idx
  ON notification_deliveries (status, updated_at);
