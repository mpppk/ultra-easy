# Operator dashboard and alerts

Parent: #51 (M7 Definition of Done: operator dashboardと最低限のalert)

Spec: `docs/observability.md` (Minimum operator dashboard / Minimum alerts).
This runbook is the operational side: where each panel comes from,
how alerts fire, and how to set up Cloudflare-side notification.

## Dashboard

### D1-backed panels (same source of truth as audit)

`GET /operator/dashboard?organizationId=<id>` on the runtime Worker
(preview: `GET /api/preview/operator-dashboard?organizationId=<id>`,
page `/preview/operator-dashboard`) returns:

1. Approval lead-time p50/p95/p99 (`action.received` → `action.completed`).
2. Step dwell-time p50/p95/p99 grouped by `stepKey`
   (`step.activated` → approved/rejected/expired).
3. Reject / expire counts and `action.completed` counts by result.
4. ActionExecutor failure count by safe error code (`action.execution_failed`).
5. Outbox backlog (`pending + failed`) and dispatch failure counts,
   always scoped by `organizationId`.

SLI computation lives in `packages/approval-core/src/operator-sli.ts`
(pure, unit tested) over D1 `action_events` loaded by
`packages/approval-d1/src/operator-dashboard.ts`.
Alert states shown on the dashboard are evaluated by the cron below.

Percentiles use linear interpolation; empty windows return `null`, never zero.

### Log-backed panels (Workers Logs queries)

OpenFGA latency/errors and Workflow retry/failure exist only as structured
log telemetry (`ConsoleTelemetrySink`, one JSON object per record).
Use these Workers Logs queries (filter by time range, replace the org):

- FGA p95 latency / errors:
  `event:"fga.check_latency_ms" OR event:"fga.list_users_latency_ms"`,
  error count: `event:"fga.error_total"`.
  Correlate with `correlation.organizationId="<org>"`.
- Workflow retry/failure:
  `event:"workflow.retry" OR event:"workflow.failed"`,
  correlate with `correlation.actionRequestId="<id>"` for end-to-end tracing.
- Executor failures: `event:"executor.failed"` with `attributes.errorCode`.

Never add Action input, Decision comments, attachment contents, credentials,
or notification payloads to log queries or dashboard dimensions.

## Alerts

### Baseline set (spec defaults, deployment-configurable)

| Key                            | Condition                                          | Duration   |
| ------------------------------ | -------------------------------------------------- | ---------- |
| `outbox_backlog`               | `outbox.backlog > 100`                             | 10 minutes |
| `outbox_failures_increasing`   | sustained increase of failed outbox + deliveries   | 5 minutes  |
| `executor_failures_increasing` | sustained increase of `action.execution_failed`    | 5 minutes  |
| `approval_dwell_p95`           | dwell p95 (max across stepKeys) exceeds tenant SLA | 5 minutes  |

`approval_dwell_p95` is disabled until a tenant SLA is documented and configured.

### Overrides (Worker env vars)

- `OPERATOR_ALERT_OUTBOX_BACKLOG` (default `100`)
- `OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES` (default `10`)
- `OPERATOR_ALERT_FAILURE_TREND_MINUTES` (default `5`)
- `OPERATOR_ALERT_DWELL_P95_SLA_MS` (unset = disabled)

Invalid values fall back to defaults.

### How firing works

The runtime Worker cron (every minute, same schedule as outbox dispatch)
evaluates every recently-active organization:

1. load dashboard SLIs + persisted alert states from D1,
2. `ok → breaching → firing` on sustained breach, back to `ok` on recovery,
3. persist states in `operator_alert_states` (idempotent replay safe),
4. emit structured records on transitions only:
   `alert.firing` (warn) / `alert.resolved` (info) with
   `attributes.alertKey` and correlation
   `operator-alert:<organizationId>:<alertKey>`.

Each evaluation also refreshes the last-observed failure counters so a single
spike does not re-fire after recovery.

### Cloudflare-side notification setup

1. Workers Logs: save a query for `event:"alert.firing"`.
2. Create a log-based alert (or external monitor polling
   `GET /operator/dashboard`) on new `alert.firing` records.
3. Alert message must link the correlation search
   (`correlationId=operator-alert:<org>:<key>`) and this runbook plus
   `stuck-action-request.md` / `dependency-outage.md` / `migration-rollback.md`.

## Staging drill

1. Deploy the runtime Worker and apply D1 migrations.
2. Open `/preview/operator-dashboard` for `organization:preview` and confirm
   lead-time/dwell/outbox panels render from real D1 data.
3. Temporarily set `OPERATOR_ALERT_OUTBOX_BACKLOG=1` (staging-only deploy flag),
   wait two cron ticks, and confirm `outbox_backlog` moves
   `ok → breaching → firing` with an `alert.firing` log record.
4. Restore the default, wait for recovery, and confirm `alert.resolved`.
5. Record the evidence below.

### Evidence — 2026-09-21 drill

- Date/time: 2026-09-21T08:05–08:24Z
- Environment / runtime version / D1: branch preview web +
  `ultra-easy-approval-runtime-preview` (feature `2c8932b7`, drill
  `--var` builds, restored plain `57f6742f`), D1
  `ad6f0cd7-ab10-40f0-bc8b-5ff251ae350f` (migrations incl. 0011 applied
  by deploy-time apply)
- Release commit: this PR (on top of `8e8afbc`, PR #66 merged)
- Dashboard snapshot (`organization:preview`, 5 actions): dwell
  `manager` p50 14.6s / `finance` p50 13.1s,
  `completedByResult={cancelled:3, executed:2}`, outbox all zero.
  Lead time is `null` (preview plans do not emit `action.received`;
  empty windows return null by design, never zero).
- Alert transitions observed: `approval_dwell_p95`
  `ok → breaching` (08:07:30Z) `→ firing` (08:09:30Z) with drill
  `OPERATOR_ALERT_DWELL_P95_SLA_MS=1` + trend window 1m, then
  `→ ok` after restoring defaults (08:11:30Z, again 08:24:30Z).
  Other three alerts stayed `ok`; cron persisted all states every minute.
- `alert.firing` / `alert.resolved` log records: `alert.resolved`
  captured live via `wrangler tail` from the cron tick:
  `{"kind":"log","level":"info","event":"alert.resolved",
"correlation":{"organizationId":"organization:preview",
"correlationId":"operator-alert:organization:preview:approval_dwell_p95"},
"attributes":{"alertKey":"approval_dwell_p95","status":"ok"}}`.
  Firing uses the identical emit path; firing states were verified
  persisted in D1 and served by the dashboard.
- Cloudflare notification wiring: documented above, not provisioned
  (manual console step per environment).
- Follow-up link: M7 parent tracking issue.
