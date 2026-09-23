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

`TelemetrySink` accepts only `SafeLogRecord | MetricRecord`. Default Worker logging uses
`ConsoleTelemetrySink`, which writes one JSON object per record.

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
