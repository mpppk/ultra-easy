# M7 Observability / Log Safety / Rate Limiting

Issue: #57 / AC-M7-007〜009

## Correlation contract

`actionRequestId` is the correlation root for one logical Action. The canonical correlation
ID is `String(actionRequestId)`; a second random trace ID is not required to follow an Action
across durable retries.

The ID is propagated through:

- HTTP and MCP structured telemetry
- Workflow params (`organizationId + actionRequestId + approvalPlanChecksum`)
- D1 domain events and projections
- OpenFGA telemetry created by the Workflow resolver
- ActionAuthorizer / ActionExecutor service-binding headers:
  - `X-UE-Organization-Id`
  - `X-UE-Action-Request-Id`
  - `X-UE-Correlation-Id`
- Notification Queue messages and delivery telemetry

All tenant-aware queries continue to require `organizationId`; correlation is never an
authorization mechanism.

## Safe structured telemetry

`TelemetrySink` accepts only `SafeLogRecord | MetricRecord`. Workers build their sink with
`telemetrySinkFromEnv(env)` (`packages/approval-runtime-cloudflare`): `ConsoleTelemetrySink`
(one JSON object per record, Workers Logs) always, plus `AnalyticsEngineTelemetrySink` when the
`TELEMETRY_ANALYTICS` binding exists (see [Time-series store](#time-series-store-workers-analytics-engine)).
Sinks are fanned out by `CompositeTelemetrySink`, which isolates a failing sink so telemetry
never breaks a request or Workflow step.

Production code must not call `console.*` directly (`no-console` lint in `vite.config.ts`,
#110); `ConsoleTelemetrySink` is the only console exit. Failures of telemetry itself are
reported as `telemetry.failed` with a safe error code (e.g. `sli_source_unavailable` when the
Workflow cannot read `action_events` to derive SLIs).

### HTTP access log

Both Workers wrap `fetch` in `withHttpAccessLog` (`packages/approval-application`), which emits
for **every** response (including 4xx/5xx and unhandled exceptions):

- `request.completed` log (`info` < 400, `warn` 4xx, `error` 5xx) with `method`, `route`
  (route template such as `/v1/organizations/{organizationId}/action-requests/{actionRequestId}`,
  never the raw path; unknown paths are `unmatched`), `httpStatus`, `durationMs`, `errorCode`
  (the problem+json `code` only) and `requestId` (`cf-ray`).
- `http.request_duration_ms` metric with the same attributes.

Correlation: requests that address an ActionRequest correlate by `actionRequestId`; everything
else (auth failures, parse errors, rate limits, Decision submissions before the ActionRequest is
resolved) correlates by `request:<cf-ray>`.

### Workflow SLI emission

Terminal-Action SLIs are derived once in a dedicated non-retrying `emit action SLI` step after
`project action result`. The step result is cached, so neither step retries nor Workflow replays
emit duplicate SLI metrics.

Allowed log attributes are deliberately small: status/result/error code/event type/step IDs,
retry flags/counts, duration and queue depth. Do **not** add arbitrary objects to this contract.

Default application logs must not contain:

- Action input or validated input values
- Decision comments
- attachment bytes, signed URLs, or object contents
- authorization credentials/tokens
- arbitrary Error objects or provider response bodies
- raw notification templates/payloads

Append-only audit is allowed to retain domain-required fields (for example Decision comment)
under the retention policy; that does not make those fields valid default log attributes.

## SLI metrics

| Metric                          | Source                     | Meaning                                    |
| ------------------------------- | -------------------------- | ------------------------------------------ |
| `approval.lead_time_ms`         | append-only Action events  | action.received → action.completed         |
| `approval.step_dwell_time_ms`   | append-only Action events  | step.activated → approved/rejected/expired |
| `approval.rejected_total`       | append-only Action events  | rejected approval steps                    |
| `approval.expired_total`        | append-only Action events  | expired approval steps                     |
| `fga.check_latency_ms`          | OpenFGA adapter            | Check latency                              |
| `fga.list_users_latency_ms`     | OpenFGA adapter            | ListUsers latency                          |
| `fga.error_total`               | OpenFGA adapter            | provider/contract errors                   |
| `workflow.retry_total`          | Workflow step boundary     | retriable step attempts                    |
| `workflow.failure_total`        | Workflow boundary          | terminal workflow failures                 |
| `action_executor.failure_total` | append-only Action events  | terminal execution failures                |
| `outbox.backlog`                | notification outbox health | pending + failed outbox rows               |
| `outbox.failure_total`          | outbox dispatcher          | Queue dispatch failures                    |

Staging verification (M8-3, 2026-09-23): `fga.check_latency_ms` is emitted by the staging re-authorization path and was observed at 572ms on real staging traffic (cold isolate, token exchange included). Submit-time checks and `fga.list_users_latency_ms` do not fire on staging yet — see `docs/runbooks/operator-dashboard.md` (Staging verification) for the exact limits and follow-ups.

Terminal workflow paths derive approval/executor SLIs from the persisted Action event sequence,
so the dashboard and audit reconstruction use the same source of truth.

## Implementation

- SLI computation: `packages/approval-core/src/operator-sli.ts` (pure) over D1
  `action_events`, loaded by `packages/approval-d1/src/operator-dashboard.ts`.
- Alert evaluation: `packages/approval-core/src/operator-alerts.ts` (pure) with
  D1-backed states (`operator_alert_states`), evaluated every minute by the
  runtime Worker cron; transitions emit `alert.firing` / `alert.resolved`.
- Dashboard API: `GET /operator/dashboard?organizationId=` (Worker),
  `GET /api/preview/operator-dashboard` + `/preview/operator-dashboard` (web).
- Operations: `docs/runbooks/operator-dashboard.md`.

## Time-series store (Workers Analytics Engine)

Issue: #108. Metrics are written to Workers Analytics Engine so dashboards and alerts can use
p95 / rates over time without recomputing from D1 or depending on log sampling/retention.

| Worker                                | Binding               | Dataset                        |
| ------------------------------------- | --------------------- | ------------------------------ |
| `ultra-easy-approval-api`             | `TELEMETRY_ANALYTICS` | `ultra_easy_telemetry_staging` |
| `ultra-easy-approval-runtime-preview` | `TELEMETRY_ANALYTICS` | `ultra_easy_telemetry_preview` |

A production environment binds its own dataset (e.g. `ultra_easy_telemetry_production`).

Data point layout (`analyticsEngineDataPoint`; append new blobs at the end only):

| Column    | Content                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `index1`  | `organizationId` (sampling key)                                           |
| `blob1`   | metric name (`fga.check_latency_ms`, ...) or `log.<event>` for warn/error |
| `blob2`   | component (`http`, `workflow`, `fga`, ...)                                |
| `blob3`   | operation                                                                 |
| `blob4`   | safe error code                                                           |
| `blob5`   | unit (`count` / `milliseconds` / `items`)                                 |
| `blob6`   | result / status                                                           |
| `blob7`   | `actionRequestId` (correlation drill-down)                                |
| `blob8`   | log level for `log.*` rows                                                |
| `double1` | metric value (1 for `log.*` rows)                                         |

`info` logs (domain events) are not written; their SLIs are already metrics.

Query with the SQL API (`POST https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql`,
API token with _Account Analytics: Read_), or connect Grafana's Cloudflare/ClickHouse-compatible
data source to the same endpoint. Always weight by `_sample_interval`:

```sql
-- FGA Check p95 latency and error count per organization, 5-minute buckets
SELECT index1 AS organization_id,
       toStartOfInterval(timestamp, INTERVAL '5' MINUTE) AS bucket,
       quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
FROM ultra_easy_telemetry_staging
WHERE blob1 = 'fga.check_latency_ms' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY organization_id, bucket ORDER BY bucket;

-- Workflow failures by error code (alert: > 0 over 5 minutes)
SELECT blob4 AS error_code, SUM(_sample_interval * double1) AS failures
FROM ultra_easy_telemetry_staging
WHERE blob1 = 'workflow.failure_total' AND timestamp > NOW() - INTERVAL '5' MINUTE
GROUP BY error_code;

-- FGA error rate over 5 minutes (alert: > 1%)
SELECT sumIf(_sample_interval * double1, blob1 = 'fga.error_total')
       / sumIf(_sample_interval, blob1 = 'fga.check_latency_ms') AS error_rate
FROM ultra_easy_telemetry_staging
WHERE blob1 IN ('fga.error_total', 'fga.check_latency_ms')
  AND timestamp > NOW() - INTERVAL '5' MINUTE;
```

## Minimum operator dashboard

Create one dashboard with an organization filter and these panels:

1. Approval lead-time p50 / p95 / p99.
2. Step dwell-time p50 / p95 / p99, grouped by `stepKey`.
3. Reject and expire counts/rates.
4. OpenFGA Check/ListUsers p95 latency and error count.
5. Workflow retry/failure count.
6. ActionExecutor failure count by safe error code.
7. Outbox backlog and dispatch failure count.

Do not put action input, comments, attachment metadata beyond immutable identifiers, or
notification content in dashboard dimensions.

## Minimum alerts

The exact thresholds are deployment-configurable. The baseline alert set is:

- **Outbox backlog:** `outbox.backlog > 100` for 10 minutes.
- **Outbox dispatch failures:** any sustained `outbox.failure_total` increase for 5 minutes.
- **Workflow failures:** `workflow.failure_total > 0` for 5 minutes.
- **Executor failures:** sustained increase in `action_executor.failure_total` for 5 minutes.
- **FGA errors:** error rate > 1% over 5 minutes.
- **FGA latency:** p95 > 1 second for 10 minutes.
- **Approval dwell:** p95 exceeds the tenant's documented operational SLA.

Alerts should link operators to the Action correlation search and the M7 runbooks.

### Implementation (#109)

All alerts are evaluated every minute by the runtime cron (`evaluateRecentOrganizationAlerts`)
and persisted in `operator_alert_states`; Slack alert text includes the runbook
(`OPERATOR_ALERT_RUNBOOKS`).

| Alert key                      | Signal source                                                                | Fires when                  |
| ------------------------------ | ---------------------------------------------------------------------------- | --------------------------- |
| `outbox_backlog`               | D1 outbox health                                                             | backlog > 100 for 10 min    |
| `outbox_failures_increasing`   | D1 outbox health                                                             | failures increase for 5 min |
| `executor_failures_increasing` | D1 `action_events`                                                           | failures increase for 5 min |
| `approval_dwell_p95`           | D1 `action_events`                                                           | p95 > SLA (when configured) |
| `workflow_failures`            | D1 `workflow.failed` events in the last 5 min                                | ≥ 1 (immediately)           |
| `stuck_action_requests`        | D1 non-terminal projections idle ≥ 15 min without a result × Workflow status | ≥ 1 (immediately)           |
| `fga_error_rate`               | Analytics Engine (`fga.error_total` / FGA call metrics, 5-min window)        | > 1% for 5 min              |
| `fga_latency_p95`              | Analytics Engine (`fga.check_latency_ms` p95, 5-min window)                  | > 1 s for 10 min            |

- **Stuck detection:** a projection in `pending` / `approved` that has not changed for
  `OPERATOR_ALERT_STUCK_AFTER_MINUTES` (default 15) and has no `action_results` row is a
  candidate (oldest 20 per organization). It is stuck when its Workflow instance is `complete`,
  `errored`, `terminated`, or cannot be found (e.g. #79: the Workflow never started). A
  Workflow still `waiting` for a decision is healthy. Each stuck request emits an `action.stuck`
  log correlated by `actionRequestId` → `docs/runbooks/stuck-action-request.md`.
- **FGA alerts** need the Analytics Engine SQL API: vars `ANALYTICS_ENGINE_ACCOUNT_ID` /
  `TELEMETRY_DATASET` (in `wrangler.jsonc`) and the secret `ANALYTICS_ENGINE_API_TOKEN`
  (API token with _Account Analytics: Read_ only, `wrangler secret put`). Without the secret the
  FGA alerts are not evaluated (stay `ok`); a failed SQL call emits `alert.signal_unavailable`.
- Overrides: `OPERATOR_ALERT_FGA_ERROR_RATE` (0.01), `OPERATOR_ALERT_FGA_LATENCY_P95_MS` (1000),
  `OPERATOR_ALERT_STUCK_AFTER_MINUTES` (15).

## Rate limiting / approval spam mitigation

The limiter key is:

`organizationId : principal.type : principal.id : operation`

This prevents one organization or principal from consuming another scope. Production uses the
D1-backed fixed-window implementation so counters are shared across Worker isolates.

Default policies are configurable at wiring time:

- ActionRequest submit: 60 / minute
- Approval Decision submit: 30 / minute
- MCP tools/call: 60 / minute

HTTP rejection uses RFC-style `429 Too Many Requests` with `Retry-After`,
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. MCP returns the
server error `-32029` with equivalent structured rate-limit data.

The Decision limit is intentionally separate from ActionRequest submission so repeated
approve/reject spam cannot starve normal Action creation.
