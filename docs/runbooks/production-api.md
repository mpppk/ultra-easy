# Production API (M8-1)

Parent: #68 / slice #70

Staging worker: `ultra-easy-approval-api`
(`https://ultra-easy-approval-api.niboshi.workers.dev`, `workers_dev=true`).
Production domain + custom-domain cutover are follow-ups.

## Auth

- Human/agent JWTs: Auth0 tenant `dev-67c6cfj2y51bmeyf.us.auth0.com`
  (JWKS `https://<domain>/.well-known/jwks.json`), audience
  `https://ultra-easy/approval-api`. `sub` maps to `user:<sub>`.
- Web login: `ultra-easy-web` (Regular Web App). Allowed Callback URLs are
  unset until the production domain is fixed (#70 follow-up).
- M2M: `ultra-easy-agent` (client credentials), authorized for the API with
  `read:action-requests` / `write:action-requests`.
- Staging humans use password-realm grant against
  `Username-Password-Authentication` (staging-only; test users
  `staging-alice@example.com` / `staging-bob@example.com`). Passwords live
  in 1Password vault `ultra-easy` as `AUTH0_STAGING_ALICE_PASSWORD` /
  `AUTH0_STAGING_BOB_PASSWORD`.
  Future resets: the `AUTH0_MGMT_TEST_CLIENT` item in the same vault holds
  an Auth0 Management API Test Application (client credentials, scopes
  `read:users` `update:users`, audience
  `https://dev-67c6cfj2y51bmeyf.us.auth0.com/api/v2/`) — exchange a token
  and `PATCH /api/v2/users/{id}` with `{password, connection}`.
  Browser login UI is a follow-up.
- Single staging org: requests outside `organization:staging` get 403.
  Multi-org mapping is a follow-up.

## Bootstrap (staging DB)

Governance bootstrap rule (docs/governance-bootstrap.md) option 1
(infra-as-code by the deployment principal):

1. `wrangler deploy` (provisions D1/Workflows/Queues on first deploy).
2. `wrangler d1 migrations apply DB --remote`.
3. Generate + apply the seed (idempotent, re-apply safe):
   `bun packages/approval-d1/bootstrap/generate-staging-seed.ts`
   `wrangler d1 execute DB --remote --file=packages/approval-d1/bootstrap/staging-seed.sql`
4. Seed contents: 4 governance definitions, `staging:ticket-update`
   definition (executor `staging`), serial direct-user policy
   (alice→bob), binding for `ticket.update`.

## FGA (staging)

- Store `01M31PMZ0DRBWZQ9D6TZ64E87W` (US), model `01M31Z81M7BA879QPYCC4TDREF`
  with `ticket` (`can_execute`/`can_approve` by `user`). Verified complete
  for Check/ListUsers approver resolution + re-auth in M8-3 — no model
  extension was needed (additive-only rule still applies to future changes).
- Token endpoint is `https://auth.fga.dev/oauth/token`
  (NOT `api.us1.fga.dev`), audience `https://api.us1.fga.dev/`.
  The worker exchanges client credentials at runtime with in-memory cache
  (`ClientCredentialsTokenProvider`); no static token secret.
  Secrets `FGA_CLIENT_ID` / `FGA_CLIENT_SECRET` via `wrangler secret put`.
- Tenant scoping: the repo client checks `ticket:<org>/<id>` objects
  (`tenantScopedOpenFgaObject`). Tuples MUST use the scoped object form,
  e.g. `ticket:organization%3Astaging/staging-e2e-1`, or checks deny.
- Relation map (staging): `ticket.update` → `can_execute`, unknown types
  fall to a nonexistent relation (fail closed).
- ID mapping (verified M8-3, shared with #70): Auth0 `sub`
  (`auth0|...`) → `UserId` `user:<sub>` (`auth0-identity.ts`) → FGA subject
  `user:<sub>` (`normalizeTypedRef`) → tuple user. Staging tuples use
  `user:auth0|6ab12807…` (alice) / `user:auth0|6ab12aa0…` (bob), identical
  to the mapped IDs. Staging authorizer + workflow resolver + tuple writes
  all go through the same `tenantScopedOpenFgaObject` scoping.
- Telemetry: re-auth checks emit `fga.check_latency_ms` / `fga.error_total`
  (M8-3 wiring via `x-ue-action-request-id`); submit-time checks and
  staging `list_users` do not emit yet — see
  `docs/runbooks/operator-dashboard.md` (Staging verification).
- Preview/test configs (`apps/approval-runtime/wrangler.jsonc`,
  `packages/approval-runtime-cloudflare/wrangler.jsonc`) now carry the same
  staging apiUrl/store/model (M8-3 本番値化). `FGA_CLIENT_ID`/`SECRET` live
  only as worker secrets, never in files.

## M8-3 staging E2E (2026-09-23, AC-M8-005)

Worker `ultra-easy-approval-api` versions `1b4d3e10` → `f9349dc3`
(telemetry wiring). FGA tuples are additive-only (new objects
`staging-m8-3-1` / `staging-m8-3-2`, no existing tuples touched):

- Direct store checks: `Check` allow (alice `can_execute`) → `true`, deny
  (`user:nobody`) → `false`; `ListUsers` `can_approve` → alice+bob.
- Resolver probe (production `OpenFgaApproverResolver` +
  `ClientCredentialsTokenProvider` against the staging store): `list` →
  both users `complete:true`, `check` alice → `true`, nobody → `false`.
- Worker flow (alice submit → `pending_approval` → alice approve → bob
  approve → re-auth → staging executor → `executed`):
  `action:ef470f50-eced-4df2-8c08-e562d4070844` (pre-telemetry) and
  `action:fcb9ffd0-2b86-42bb-92bd-82cac9ee8fdd` (post-telemetry, re-auth
  emitted `fga.check_latency_ms=572ms` captured via `wrangler tail`).
- API-level deny: bob submit without `can_execute` → 403
  `fga_check_denied` (no state change).
- Preview worker `ultra-easy-approval-runtime-preview` (`abb98a5d`) deployed
  with staging FGA vars + secrets; cron ticks healthy post-deploy.

## Decisions

`POST .../approval-tasks/:id/decisions` accepts (202) then delivers inline
via `onDecisionAccepted` hook. Crash-window leftovers are swept by the cron
(`listPending` + `ApprovalDecisionCommandProcessor`, idempotent).
New `listPending` on `ApprovalCommandRepository` + D1 implementation.

## Idempotency

`Idempotency-Key` header required on POSTs. 5xx responses are ALSO recorded
as completed (replay the error) so a transient failure never wedges the key
in `pending` → permanent 409 `in_progress`. (Fixed during M8-1 staging.)

## Dashboard / alerts

`GET /operator/dashboard?organizationId=` serves staging SLIs from the same
D1 (see `docs/runbooks/operator-dashboard.md`). Cron evaluates alerts and
POSTs `firing`/`resolved` transitions to Slack (`SLACK_WEBHOOK_URL` secret).

## Notifications (M8-2)

- Domain events flow: D1 outbox → `dispatchNotificationOutbox` (cron) →
  Cloudflare Queue → `consumeNotificationMessage` (queue consumer) →
  `SlackWebhookSink` (`packages/approval-runtime-cloudflare/src/slack.ts`)
  POSTing the Incoming Webhook. At-least-once; duplicate deliveries reuse
  the same `notificationKey`/delivery idempotency key and are skipped after
  `sent`.
- Slack payload is correlation-only (event type, action/org IDs,
  notification key, timestamp). No Action input, Decision comments,
  attachment contents, or credentials — in payload, logs, or dashboard.
- `SlackWebhookSink` classifies `429`/`5xx`/`408` as retriable (queue retry →
  DLQ after `max_retries: 5`) and other `4xx` as non-retriable; timeouts
  (8s) and network errors are retriable.
- When `SLACK_WEBHOOK_URL` is unset the queue consumer succeeds no-op
  (pre-provisioning staging behavior) and alert Slack delivery is skipped;
  both emit the normal structured logs.
- Queues: staging `ultra-easy-notifications-staging` (+ `-dlq`) is the
  default in `wrangler.jsonc`; production `ultra-easy-notifications`
  (+ `-dlq`) lives in the `env.production` block (same `NOTIFICATION_QUEUE`
  binding). Cutover = `wrangler deploy --env production` in the same window
  as the production log-alert creation (see `operator-dashboard.md`).
- Secrets: `SLACK_WEBHOOK_URL` via `wrangler secret put` only (per
  environment); source of truth is 1Password vault `ultra-easy` (`SLACK`).

## Known gaps (follow-ups, not M8-1)

- Browser login UI + session management (M2M + password-realm only).
- `action.received` is not emitted on the v1 submit path, so lead-time SLI
  stays null on production data (completed/dwell work).
- Custom domain + ultra-easy-web callback URLs.
- Staging executor is a success-echo sink (no external side effects by design).
