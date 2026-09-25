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
- Organization membership (#82) is verified from the token, never assumed:
  - `AUTH0_ORGANIZATION_CLAIM_VALUE` (+ optional `AUTH0_ORGANIZATION_CLAIM`,
    default `org_id`): the claim must equal the Auth0 Organization ID. Required
    for production.
  - `AUTH0_TENANT_IS_ORGANIZATION=true`: explicit opt-in that trusts every
    user/client of the tenant as a member. Staging only. **Precondition: public
    signup is disabled on `Username-Password-Authentication`** (Auth0 dashboard →
    Authentication → Database → Disable Sign Ups), otherwise anyone could mint a
    member token.
  - Neither set → every request is 403 `organization_membership_unverified`.
- Scopes (#82) are checked per operation (`scope` or RBAC `permissions`):
  reads need `read:action-requests`; submit and decisions need
  `write:action-requests`. Human tokens must request them, e.g. password-realm
  `scope: "openid read:action-requests write:action-requests"`.
- Token kinds (#82): client-credentials tokens (`gty=client-credentials`,
  `sub=<client>@clients`) become `agent:<client_id>` principals (they can read /
  submit within their scopes but never decide approvals or use the inbox).
  Unknown `gty` values or inconsistent `sub`/`gty` pairs are 401
  `unsupported_token_type`. `alg` is pinned to RS256.
- Read access (#83): ActionRequest / tasks / task detail are visible to the actor,
  authority, caller, task candidates / deciders, and operators
  (`authorization_admin:root#viewer`); a Decision command to its issuer and
  operators. Everyone else gets 404 (existence is not disclosed).

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
   (alice→bob; v2 opts alice's step into self approval, see Decisions),
   binding for `ticket.update`.

## FGA (staging)

- Store `01M31PMZ0DRBWZQ9D6TZ64E87W` (US). M8 model `01M31Z81M7BA879QPYCC4TDREF`
  was superseded additively by the M9 GitOps model `01M38K1Q55CCNETS1V6XHJZJTB`
  (`packages/approval-fga/openfga/model.fga` @ 319bcda: `ticket` + `authorization_admin`).
  `ticket` (`can_execute`/`can_approve` by `user`). Verified complete
  for Check/ListUsers approver resolution + re-auth in M8-3 — no model
  extension was needed (additive-only rule still applies to future changes).
- Token endpoint is `https://auth.fga.dev/oauth/token`
  (NOT `api.us1.fga.dev`), audience `https://api.us1.fga.dev/`.
  Override with the optional vars `FGA_API_TOKEN_ISSUER` (host or full token
  URL) / `FGA_API_AUDIENCE`; when unset, the audience follows the origin of
  `OPENFGA_API_URL` (e.g. `https://api.eu1.fga.dev/`).
  The worker exchanges client credentials at runtime. The provider is shared
  per isolate (`sharedFgaTokenProvider`, keyed by client/secret/endpoint/audience),
  so one exchange serves every request and Workflow step until 60s before
  expiry (#90). Expiry comes from the JWT `exp` (decoded with `atob`, no
  `nodejs_compat` needed) or `expires_in`. No static token secret.
  Secrets `FGA_CLIENT_ID` / `FGA_CLIENT_SECRET` via `wrangler secret put`.
- Auth0 JWKS is fetched once per isolate per tenant domain
  (`auth0KeyResolver`); jose refreshes it on an unknown `kid` (key rotation).
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

`POST .../approval-tasks/:id/decisions` pre-checks business constraints before
accepting (spec part-14 §10): closed task / already decided → 409, self approval /
non-candidate of a snapshot task → 403, missing required comment → 422. The final
verdict is still re-validated by the Workflow interpreter.

Accepted commands (202) are delivered inline via the `onDecisionAccepted` hook;
leftovers are swept by the cron (`listDuePending` across organizations +
`ApprovalDecisionCommandProcessor`). Command status (#79 / #88):

- `pending` → claimed with a lease (`lease_until`) so inline + cron never deliver
  concurrently. A retriable delivery failure stays `pending` with
  `attempt_count` / `next_attempt_at` backoff (30s doubling, max 1h, 10 attempts);
  only exhausting the retries or a non-retriable failure becomes `failed`.
- `delivered` = sent to the Workflow. The Workflow writes the business outcome with
  a compare-and-set: `applied` (accepted) or `rejected` (+ `error.code`, and an
  `approval_decision.rejected` audit event). A rejected decision never stops the
  Workflow; it keeps waiting on the same task.
- Migration `0015_approval_command_delivery.sql` adds the columns + due index.

Self approval (#87): an omitted `selfApproval` is materialized as `deny`
(subject = authority principal), except `purpose: execution_consent` which defaults
to `allow`. Existing Plans keep their old semantics. The staging seed publishes
policy version 2 that opts alice's steps into `allow` explicitly (alice is the only
requester in staging); bob's steps keep the SoD default.

## Idempotency

`Idempotency-Key` header required on POSTs (#92):

- A reservation is `pending` with a lease (`locked_until`, default 60s). While
  the lease is live, a retry of the same key gets 409 `idempotency_request_in_progress`
  with `Retry-After`. After it expires (crash / timeout, or a legacy row with
  `locked_until IS NULL`), a retry of the same payload takes the reservation over.
- Retriable responses (429 / 502 / 503 / 504) are NOT recorded: the reservation
  is released so the same key re-executes. Only non-retriable responses
  (2xx / 4xx / a definitive 500) are stored as `completed` and replayed.
- Replays do not consume the rate limit (the decision limiter runs after the
  reservation is acquired).
- Non-JSON bodies are hashed by raw text, so different payloads never collide.
- Migration `0014_api_idempotency_lease.sql` adds `locked_until`.

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
- `SlackWebhookSink` classifies `429`/`5xx`/`408` as retriable and other `4xx`
  as non-retriable; timeouts (8s) and network errors are retriable. The queue
  consumer (`handleNotificationQueueBatch`, shared by approval-api and the
  preview runtime) retries only retriable failures, with backoff
  (`delaySeconds` 10s doubling, max 600s, DLQ after `max_retries: 5`).
  Non-retriable failures record the delivery as `failed` and are acked (#94).
- Slack Incoming Webhook posts to one channel, so the sink's audience is
  `channel`: one post per outbox event (delivery recipient `channel`), not
  one identical post per candidate.
- When `SLACK_WEBHOOK_URL` is unset, deliveries are recorded as `skipped`
  (never `sent`) and the outbox entry becomes `skipped`; the metric is
  `notification.skipped_total` (not `outbox.failure_total`). Once the secret
  is set, the cron re-queues skipped entries (`requeue_skipped_notifications`).
- Outbox dispatch (queue send) failures back off via `next_attempt_at`
  (1 min doubling, max 1 h) and become `dead` after 8 attempts. Messages that
  land in the DLQ are consumed and mark their outbox entry `dead`
  (`outbox.dead_total`, `notification.dead`). Dead entries count towards
  `outbox_failures_increasing`. Migration `0017_notification_delivery_states.sql`.
- Queues: staging `ultra-easy-notifications-staging` (+ `-dlq`) is the
  default in `wrangler.jsonc`; production `ultra-easy-notifications`
  (+ `-dlq`) lives in the `env.production` block (same `NOTIFICATION_QUEUE`
  binding). Cutover = `wrangler deploy --env production` in the same window
  as the production log-alert creation (see `operator-dashboard.md`).
- Secrets: `SLACK_WEBHOOK_URL` via `wrangler secret put` only (per
  environment); source of truth is 1Password vault `ultra-easy` (`SLACK`).

## Production environment (`--env production`, #84)

Wrangler bindings and vars are non-inheritable, so `env.production` in
`apps/approval-api/wrangler.jsonc` declares every binding itself: `DB`
(`ultra-easy-approval-production`), `ACTION_AUTHORIZER` / `ACTION_EXECUTOR` (pointing at the
production worker `ultra-easy-approval-api-production`), `ACTION_WORKFLOW`,
`NOTIFICATION_QUEUE` (+ DLQ consumer) and `TELEMETRY_ANALYTICS`. CI runs
`wrangler deploy --dry-run --env production` (`deploy:dry-run:production`) on every PR, and
`src/config.test.ts` asserts both environments declare all required bindings.

Tenant-specific settings are added when the production Auth0 tenant / FGA store are
provisioned (they do not exist yet):

| Setting                                                                                            | Kind                       |
| -------------------------------------------------------------------------------------------------- | -------------------------- |
| `AUTH0_DOMAIN`, `AUTH0_API_AUDIENCE`                                                               | vars                       |
| `AUTH0_ORGANIZATION_CLAIM_VALUE` (Auth0 Organization ID; `org_id` claim is required in production) | vars                       |
| `OPENFGA_STORE_ID`, `OPENFGA_AUTHORIZATION_MODEL_ID`                                               | vars                       |
| `FGA_CLIENT_ID`, `FGA_CLIENT_SECRET`                                                               | secret                     |
| `SLACK_WEBHOOK_URL`, `ANALYTICS_ENGINE_API_TOKEN`                                                  | secret (optional features) |

Fail-fast: the Worker validates required bindings/settings once per isolate
(`src/config.ts`). While anything is missing, `fetch` answers
`503 configuration_invalid`, cron does nothing and queue batches are retried (not acked), and a
`request.failed` / `scheduled.task_failed` log carries `configKeys` = the missing/invalid
setting names (never values). Check that log first after a production deploy.

## Known gaps (follow-ups, not M8-1)

- Browser login UI + session management (M2M + password-realm only).
- Custom domain + ultra-easy-web callback URLs.
- Staging executor is a success-echo sink (no external side effects by design).
