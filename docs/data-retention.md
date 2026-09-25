# Data retention (#99)

D1 holds three kinds of data with different lifetimes.

## Audit trail — append-only, never purged

| Table                               | Enforcement                                                         |
| ----------------------------------- | ------------------------------------------------------------------- |
| `action_events`                     | `BEFORE UPDATE / DELETE` triggers `RAISE(ABORT)` (migration `0019`) |
| `force_cancel_audit`                | same (migration `0019`)                                             |
| `authorization_relationship_events` | same (migration `0012`)                                             |

The application never updates or deletes these rows, and the database rejects it even from
buggy code. `appendMany` (like `append`) verifies that a duplicate `eventKey` carries the same
content instead of silently ignoring a different event. Archiving the audit trail (e.g. to R2)
would be a dedicated, reviewed migration path; there is none today, so audit rows are kept
indefinitely.

## Domain state — kept

`action_requests` (Materialized Plans), `approval_runtime_projections`, `approval_tasks`,
`approval_task_candidates`, `action_results`, governance tables and MCP tables are the state of
record for ActionRequests and are not purged.

## Operational data — purged by the cron

`purge_expired_operational_data` (`purgeExpiredOperationalData`, both approval-api and the
preview runtime) deletes at most 1,000 rows per table per run, oldest first:

| Table                     | Deleted when                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `rate_limit_counters`     | the window closed more than 1 hour ago                                                                        |
| `api_idempotency_keys`    | `completed` for more than 7 days, or a `pending` reservation whose lease expired more than 1 day ago          |
| `approval_commands`       | terminal (`applied` / `rejected` / `failed`) for more than 90 days (`pending` / `delivered` are never purged) |
| `outbox_events`           | `dispatched` / `skipped` older than 30 days; `dead` / `failed` older than 90 days (`pending` is never purged) |
| `notification_deliveries` | `sent` / `skipped` older than 30 days; `failed` older than 90 days                                            |

After a purge an Idempotency-Key older than 7 days is treated as new, and a Decision command
older than 90 days returns 404. The periods live in `DEFAULT_OPERATIONAL_RETENTION_POLICY`
(`packages/approval-d1/src/retention.ts`).
