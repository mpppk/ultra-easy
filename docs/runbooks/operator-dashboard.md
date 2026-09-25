# Operator dashboard and alerts

Parent: #51 (M7 Definition of Done: operator dashboardと最低限のalert)

Spec: `docs/observability.md` (Minimum operator dashboard / Minimum alerts).
This runbook is the operational side: where each panel comes from,
how alerts fire, and how to set up Cloudflare-side notification.

## Dashboard

### D1-backed panels (same source of truth as audit)

`GET /operator/dashboard?organizationId=<id>` on the runtime Worker
(preview: `GET /api/preview/operator-dashboard?organizationId=<id>`,
page `/preview/operator-dashboard`) returns the panels below.

On `ultra-easy-approval-api` the endpoint requires a user Bearer token whose
principal is an operator (`authorization_admin:root#viewer` in FGA, same as the
authorization console). `organizationId` is optional and must match the caller's
organization (403 `organization_mismatch` otherwise); unauthenticated → 401,
non-operator → 403 `operator_access_denied`, FGA/D1 failures → 503 without
internal messages (#81).

Panels:

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

Query budget (#95): a snapshot is a constant number of D1 queries regardless of history
(one query for the latest 200 ActionRequests' events, one grouped outbox/delivery count).
The cron evaluates organizations seen in the last 10,000 events plus any organization with a
non-`ok` alert (so a quiet organization still resolves), sweeps due Decision commands across
organizations directly from `approval_commands (status, next_attempt_at)`, and runs each task
independently (`runScheduledTasks`). The inbox reads the normalized `approval_task_candidates`
index (migration `0018`) instead of `json_each` over every task, and task lists reuse the
loaded Plan per ActionRequest within a request.

### Log-backed panels (Workers Logs queries)

OpenFGA latency/errors and Workflow retry/failure exist only as structured
log telemetry (`ConsoleTelemetrySink`, one JSON object per record).
Use these Workers Logs queries (filter by time range, replace the org):

- FGA p95 latency / errors:
  `event:"fga.check_latency_ms" OR event:"fga.list_users_latency_ms"`,
  error count: `event:"fga.error_total"`.
  Correlate with `correlation.organizationId="<org>"`.

### Staging verification (M8-3, 2026-09-23)

Staging worker `ultra-easy-approval-api` (version `f9349dc3`) emits
`fga.check_latency_ms` from the Workflow re-authorization path
(`StagingActionAuthorizer` with `x-ue-action-request-id`, telemetry wired
in M8-3). Observed via `wrangler tail --format json` during the M8-3 E2E:

- `fga.check_latency_ms=572ms` for
  `action:fcb9ffd0-2b86-42bb-92bd-82cac9ee8fdd` (first check on a cold
  isolate, includes the client-credentials token exchange against
  `auth.fga.dev`).
- Deny path surfaces as `request.denied` with
  `attributes.errorCode="fga_check_denied"` (submit-time check for a
  principal without `can_execute`, e.g.
  `action:f26f0d2c-5b61-4cc0-a300-654df4a9c490`).

Known limits (follow-ups, not M8-3):

- Submit-time checks do not emit `fga.check_latency_ms` yet — the
  `ActionAuthorizer` contract carries no `actionRequestId` (the ID is minted
  after authorization), so the staging authorizer only emits when the
  `x-ue-action-request-id` header is present (Workflow re-auth path).
- `fga.list_users_latency_ms` never fires on staging: the staging policy
  uses direct-user approvers, so `OpenFgaApproverResolver.list` short-circuits
  before ListUsers. ListUsers approver resolution against the staging
  store/model is verified instead by the M8-3 resolver probe (production
  `OpenFgaApproverResolver` code path, `can_approve` on
  `ticket:organization%3Astaging/staging-m8-3-1` → alice+bob,
  `complete:true`) plus `OPENFGA_TEST_URL` integration tests.
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

### Alert → Slack direct delivery (M8-2)

The cron also POSTs every `firing`/`resolved` transition to the Slack
Incoming Webhook (`SLACK_WEBHOOK_URL` secret) via
`notifyAlertTransitionViaSlack` (`packages/approval-runtime-cloudflare/src/slack.ts`).
Payload is alertKey + transition + org only — no credentials, Action input,
Decision comments, or attachment contents. A failed POST is recorded as
`notification.failed` log + `outbox.failure_total` metric and never breaks
the cron tick. When the secret is unset (e.g. pre-provisioning staging),
Slack delivery is skipped gracefully; the structured log records above are
still emitted.

Secret setup (plaintext commit禁止):

1. Source of truth is the 1Password vault `ultra-easy` (`SLACK` item;
   create it if missing — workspace Incoming Webhook URL).
2. `op read "op://ultra-easy/SLACK/credential" | wrangler secret put SLACK_WEBHOOK_URL -C apps/approval-api`
   (staging and production use separate values; repeat per environment).
3. The URL never appears in logs, dashboard snapshots, or Slack payloads.

### Cloudflare-side notification setup

Two independent channels (both safe-payload only):

A. Direct Slack delivery (M8-2, automatic once the secret is set) — see above.
B. Log-based alert (manual console step per environment, staging → production):

1. Workers Logs: save a query for `event:"alert.firing"`.
2. Create a log-based alert (or external monitor polling
   `GET /operator/dashboard`) on new `alert.firing` records.
3. Alert message must link the correlation search
   (`correlationId=operator-alert:<org>:<key>`) and this runbook plus
   `stuck-action-request.md` / `dependency-outage.md` / `migration-rollback.md`.

#### Staging → production log-alert creation procedure

1. Staging: in the Cloudflare dashboard, open Workers Logs for
   `ultra-easy-approval-api`, save the `event:"alert.firing"` query,
   and create the log-based alert pointing at the staging Slack channel.
   Verify with the staging drill below (`firing → Slack` arrival).
2. Production cutover: duplicate the saved query/alert against the
   production worker (`ultra-easy-approval-api` production env),
   re-point the notification target to the production channel, and confirm
   the first `alert.resolved` (or drill `firing`) arrives post-cutover.
3. Queue cutover (same change window): switch `NOTIFICATION_QUEUE` from
   `ultra-easy-notifications-staging` (+ `-dlq`) to
   `ultra-easy-notifications` (+ `-dlq`) via the `env.production` block in
   `apps/approval-api/wrangler.jsonc`, then `wrangler deploy --env production`.
   At-least-once + `notificationKey`/delivery idempotency are preserved
   because the consumer reuses the same keys across redelivery.
4. Keep the staging queue + DLQ provisioned for drills; never delete the
   staging alert — it guards the staging environment independently.

## Staging drill

1. Deploy the runtime Worker and apply D1 migrations.
2. Open `/preview/operator-dashboard` for `organization:preview` and confirm
   lead-time/dwell/outbox panels render from real D1 data.
3. Temporarily set `OPERATOR_ALERT_OUTBOX_BACKLOG=1` (staging-only deploy flag),
   wait two cron ticks, and confirm `outbox_backlog` moves
   `ok → breaching → firing` with an `alert.firing` log record.
4. Restore the default, wait for recovery, and confirm `alert.resolved`.
5. Record the evidence below.

### Approval API worker drill (M8-2, AC-M8-003/004)

Target: `ultra-easy-approval-api` + queue
`ultra-easy-notifications-staging` (+ DLQ). Isolate with a dedicated org
(`organization:m8-2-drill`); never touch `organization:staging` rows.

1. Deploy the branch (`wrangler deploy` from `apps/approval-api`).
2. AC-M8-003: insert `action.received` + `action.completed` (`m8-2-` keys)
   plus one `pending` outbox row for the drill org via
   `wrangler d1 execute DB --remote --file`. Wait two cron ticks and confirm:
   outbox `pending → dispatched`, `notification_deliveries` → `sent` with a
   stable `notificationKey`, dashboard backlog → 0, and a
   `notification.skipped` warn + `outbox.failure_total` metric (secret
   unprovisioned degraded path). Redelivery skip is covered by the
   mock-webhook integration test (`slack-delivery.integration.test.ts`).
3. AC-M8-004: give the drill org dwell data (`step.activated` → `step.approved`,
   `m8-2-` keys), then drill-deploy with staging-only vars:
   `wrangler deploy --var OPERATOR_ALERT_DWELL_P95_SLA_MS:1
--var OPERATOR_ALERT_FAILURE_TREND_MINUTES:1`.
   Wait two ticks and confirm `approval_dwell_p95` moves
   `ok → breaching → firing` with `alert.firing` warn records plus a
   per-transition Slack attempt (`notification.skipped` while the secret is
   unprovisioned). Note: the threshold override is global, so
   `organization:staging` fires transiently too — this is expected drill noise.
4. Restore immediately (`wrangler deploy` without `--var`), wait two ticks,
   and confirm `firing → ok` with `alert.resolved` info records on every
   affected org and default thresholds served by the dashboard again.
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

### Evidence — 2026-09-23 drill (M8-2, AC-M8-003/004)

- Date/time: 2026-09-23T06:18–06:43Z.
- Worker: `ultra-easy-approval-api`
  (`https://ultra-easy-approval-api.niboshi.workers.dev`, cron `*/1 * * * *`).
  Versions: `f889ade0` (initial M8-2 deploy) → `b7d5cbb1` (threshold-override
  support) → `f1f4be98` (final code) → `887c87ec` (drill `--var` #1) →
  `508ee83d` (restore #1) → `71f3a94b` (drill `--var` #2) → `59c48336`
  (restore #2, live at drill end). D1 `ultra-easy-approval-api-db`
  (`830e02ba-fbc1-4d0d-8dba-e347b723cadb`); queues
  `ultra-easy-notifications-staging` + `-dlq` (pre-existing, kept).
  Release commit: this PR (on top of `37b5d22`).
- Isolation: all drill rows use org `organization:m8-2-drill` and `m8-2-`
  keys. `organization:staging` rows untouched; its `approval_dwell_p95`
  fired transiently during the global threshold drill (expected, recovered
  to `ok`). Pre-existing staging activity (action `fcb9ffd0…` completing via
  the cron decision sweep) is unrelated to the drill.
- Cross-work note: version `f9349dc3` (2026-09-23T06:22:24Z) is a #72-side
  deploy (`mpppk/m8-3-openfga-ac-m8-005`, commit `bc1b348`); m8-2 drill
  evidence below is on m8-2 versions only, live is the m8-2 restore `59c48336`.
- AC-M8-003 dashboard snapshot (`organization:m8-2-drill`, post-delivery):
  `leadTimeMs.count=1, p50=30000`, `completedByResult={executed:1}`,
  `outbox={pending:0, failed:0, failedDeliveries:0, backlog:0}` (was
  `pending:1` before the 06:22:01Z cron tick). Outbox row
  `outbox:…:action.completed:m8-2` went `pending → dispatched`
  (`dispatched_at=2026-09-23T06:22:01.000Z`); delivery row for
  `user:m8-2-drill` went to `sent`
  (`sent_at=2026-09-23T06:22:06.737Z`, `attempt_count=1`) under the stable
  `notification:…:action.completed:m8-2` key. Duplicate-delivery skip is
  proven by `slack-delivery.integration.test.ts` (mock webhook: 500 once →
  retry with the same key → `sent`, redelivery → `skipped`, no extra POST).
- AC-M8-003 log records (`wrangler tail`, worker `b7d5cbb1`):
  `{"kind":"log","level":"warn","event":"notification.skipped",
"correlation":{"organizationId":"organization:m8-2-drill",
"actionRequestId":"action:m8-2-drill-1",…},
"attributes":{"errorCode":"slack_webhook_missing"}}` plus
  `outbox.failure_total=1` metric — the degraded path (secret unprovisioned).
- AC-M8-004 alert transitions (`approval_dwell_p95`, drill `--var`
  `OPERATOR_ALERT_DWELL_P95_SLA_MS=1` + `OPERATOR_ALERT_FAILURE_TREND_MINUTES=1`):
  drill org and staging org both moved `ok → breaching → firing` (dashboard
  showed `firing` with thresholds
  `{outboxBacklogLimit:100, …, failureTrendMinutes:1, dwellP95SlaMs:1}`),
  then `firing → ok` after the plain restore deploy (dashboard `ok` at
  `2026-09-23T06:42:59.000Z` with baseline thresholds,
  `dwellP95SlaMs:null`). Live-captured (`wrangler tail`) transition logs:
  `alert.firing` (warn) ×2, `alert.resolved` (info, `status:breaching` then
  `status:ok`) ×4, each transition accompanied by `notification.skipped`
  (warn, `errorCode:slack_webhook_missing`) — the per-transition Slack
  attempt without a provisioned secret.
- Slack real arrival: NOT verified — no `SLACK` item exists in 1Password vault
  `ultra-easy`, so `SLACK_WEBHOOK_URL` was never set (payload-secret hygiene
  kept: no URL/commit). Human follow-up (see PR): register the webhook URL in
  1Password → `wrangler secret put SLACK_WEBHOOK_URL -C apps/approval-api` →
  re-run the §Approval API worker drill and confirm arrival.

### Evidence — 2026-09-23 re-drill (M8-2 fix verification, AC-M8-003/004 real Slack arrival)

- Date/time: 2026-09-23T12:32–15:29Z (all UTC).
- Worker: `ultra-easy-approval-api`
  (`https://ultra-easy-approval-api.niboshi.workers.dev`, cron `*/1 * * * *`).
  Live at end: `e62a53d6` (fix branch `fix/m8-2-slack-fetch-binding` built on
  main `f63393d`). D1 `ultra-easy-approval-api-db`
  (`830e02ba-fbc1-4d0d-8dba-e347b723cadb`); queues
  `ultra-easy-notifications-staging` + `-dlq` (kept).
- Root cause found by this drill: every Slack POST from the worker failed with
  `slack_webhook_network_error` / `TypeError` / no HTTP response (18 alert
  notifies + 12 queue deliveries, 0 successes), while a disposable probe
  worker on the same account reached `hooks.slack.com` fine and a human `curl`
  of the webhook URL got Slack `ok`. A temporary instrumented deploy captured
  the sanitized failure detail:
  `TypeError :: Illegal invocation: function called with incorrect 'this'
reference`. The sink stored the bare `fetch` reference as its default
  `fetchImpl` (`?? fetch` in `SlackWebhookSink` constructor and in
  `notifyAlertTransitionViaSlack`); workerd requires `fetch` to be called
  with a valid receiver, so every detached call threw before any network
  activity. Direct `fetch()` calls (FGA/Auth0 paths, probe worker) and mock
  `fetchImpl` unit tests never exhibited it — hence the escape. This also
  explains why `approval-fga` (already `globalThis.fetch.bind(globalThis)`)
  always worked.
- Fix (this branch): both `?? fetch` defaults unified to
  `defaultFetchImpl()` = `globalThis.fetch.bind(globalThis)`, matching the
  repo convention; regression tests assert the stored default is not the bare
  reference plus offline loopback (`127.0.0.1:9`) behavioral coverage for the
  sink and alert default paths (`cloudflare:test` has no `fetchMock` in this
  toolchain, documented in-test). The temporary message-capture
  instrumentation was fully reverted; only the fix + tests ship.
- AC-M8-003 (post-fix, `m8-2-redrill-3`): staging production path
  `action:df66ec13-36b9-42a2-a607-4e9ae1955957`
  (resource `ticket:staging-e2e-1`, pre-existing FGA tuples reused —
  no FGA/Auth0/D1-config changes): submit (alice) 15:21:22Z →
  alice manager-approve 15:21:43Z → bob finance-approve 15:22:04Z →
  `executed`. Both `step.activated` notifications went `sent` on attempt 1
  (`sent_at` 15:22:24.429Z alice-step / 15:22:25.629Z bob-step, stable
  notificationKeys, no duplicate POSTs). Dashboard `failedDeliveries` did not
  increase (stays 4 = pre-fix historical rows), backlog 0. Slack arrival of
  the two `[ultra-easy] notification step.activated …` posts confirmed by
  human eyes (see PR).
- AC-M8-004 (post-fix): override `c06248f0` (15:25:08Z,
  `OPERATOR_ALERT_DWELL_P95_SLA_MS=1` +
  `OPERATOR_ALERT_FAILURE_TREND_MINUTES=1`) → `breaching` 15:26:21Z →
  `firing` 15:27:22Z (`alert.firing` warn ×2 orgs, zero
  `notification.failed`/`notification.skipped` in `wrangler tail` — every
  transition POST succeeded) → plain restore `e62a53d6` (15:28:13Z) →
  all `ok` 15:29:30Z with baseline thresholds. Slack arrival of the
  `[ultra-easy alert] approval_dwell_p95: …` transition posts confirmed by
  human eyes (see PR).
- Pre-fix drill artifacts kept for the record: `failedDeliveries=4`
  (two `step.activated` deliveries ×2 actions, 6 attempts each, last_error
  `Slack webhook POSTに失敗しました`) and their DLQ messages; alert
  transition history (`ok → breaching → firing → ok` ×3 drill rounds).
  No D1 destructive operation was performed (read-only SELECT + API-driven
  inserts only).
- 人間目視確認済み (2026-09-24 00:22〜00:29 JST): 上記AC-M8-003 2件 +
  AC-M8-004 6件のSlack到達を人間が目視確認 (重複なし)。
