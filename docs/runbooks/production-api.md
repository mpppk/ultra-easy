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
- Client registry (#193): set `AUTH0_WEB_CLIENT_ID`, `AUTH0_AGENT_CLIENT_ID`,
  `AUTH0_KNOWLEDGE_CLIENT_ID`, and `AUTH0_KNOWLEDGE_AGENT_CLIENT_ID` on the approval API
  deployment to the four Auth0 application client IDs. The first two have unrestricted
  first-party grants; Knowledge user tokens are limited to `knowledge.*` actions on
  `knowledge_page` / `knowledge_space`, and the Knowledge M2M agent to
  `knowledge.maintain_space` on `knowledge_space`. Unregistered clients receive 403
  `client_not_registered`. The Knowledge Regular Web Application needs a user client
  grant for the approval API with `read:action-requests` / `write:action-requests`;
  its separate M2M Application needs a client credentials grant for those scopes.
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
    Authentication → Database → Disable Sign Ups), and social connections that
    permit self-service registration (such as Google) are disabled for every
    application in the tenant. Otherwise anyone could mint a member token.
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

## Public Workflow Run projection (#196)

Application clients submit an optional `correlation` object alongside `action` in
`POST /v1/organizations/{organizationId}/action-requests`. It contains up to 16
string keys (`[A-Za-z][A-Za-z0-9_]{0,63}`), each with a nonempty value of at most
255 characters. For example, `{"correlation":{"spaceId":"space:one","pageId":"page:one"}}`.
The object is immutable metadata stored with the ActionRequest and returned by
ActionRequest reads. Do not place credentials in correlation values.

These `GET` routes require the same Auth0 `read:action-requests` scope as the parent
ActionRequest and enforce its actor / authority / caller / approval participant /
organization operator read policy. The client registry also checks the parent
action type and resource type. A run with no parent ActionRequest (for example a
direct Studio run) is available through the Studio admin route, not these routes.

| Route                                                                                                           | Result                                                              |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `/v1/organizations/{organizationId}/workflow-runs/{runId}`                                                      | One public run view by run ID                                       |
| `/v1/organizations/{organizationId}/action-requests/{actionRequestId}/workflow-run`                             | The run started by an ActionRequest                                 |
| `/v1/organizations/{organizationId}/workflow-runs?correlationKey=spaceId&correlationValue=space%3Aone&limit=50` | `{ "items": [...] }`; repeat `correlationValue` for multiple values |

The view contains `id`, `actionRequestId`, `actionType`, `organizationId`,
`status`, `correlation`, `requestedBy`, timestamps, `nodes`, `childActions`,
`approvals`, `humanInputs`, `failure`, and `audit`. Node and child status, task
candidate IDs, and audit event types are included. Raw workflow input/variables,
LLM outputs, sandbox state, provider errors, and event data are excluded.
`humanInputs` contains only a key and status for ordinary run readers. An
explicitly assigned user may also read the run by ID and receives that input's
prompt, options, subject, analysis, and accepted answer. Other inputs remain
redacted.

The assigned user can list waiting inputs with
`GET /v1/organizations/{organizationId}/me/human-inputs?limit=50` using a
`read:action-requests` token. Each item includes `key` (the effect ID), `runId`,
`actionRequestId`, `prompt`, `assigneeId`, optional `options` / `answerSchema` /
`subject` / `analysis`, and `requestedAt`. Pass `nextCursor` as `cursor` to read
the next page. The list includes only inputs assigned to the authenticated user
and permitted by the parent ActionRequest's client scope.

Answer with
`POST /v1/organizations/{organizationId}/workflow-runs/{runId}/human-inputs/{key}/answer`,
`Idempotency-Key: <unique key>`, a user token with `write:action-requests`, and
`{"answer":"keep"}`. A matching retry returns the same response. A different
answer to a completed input returns 409. The answer is persisted with a CAS
transition and audited before the Workflow runner is resumed; the due-run
sweeper provides fallback if the resume signal fails.

Invalid IDs, limit (1–100), or correlation filters return 400. Missing and
unreadable runs return the same 404 `workflow_run_not_found`; list results omit
unreadable runs. Authentication failures return 401 or 403. Repository failures
return 503 when retriable, otherwise 500, with a code only and no internal
error text. Every lookup and filter includes the organization ID.

## Bootstrap (staging DB)

Governance bootstrap rule (docs/governance-bootstrap.md) option 1
(infra-as-code by the deployment principal):

1. First time only: `vp -C apps/approval-api run bootstrap:staging` (deploy provisions
   D1/Workflows/Queues, then migrates). Afterwards every deploy is migrate → deploy
   (`deploy:staging`, or the `deploy` GitHub Actions workflow — see Deployment below).
2. Generate + apply the seed (idempotent, re-apply safe):
   `bun packages/approval-d1/bootstrap/generate-staging-seed.ts`
   `wrangler d1 execute DB --remote --file=packages/approval-d1/bootstrap/staging-seed.sql`
3. Seed contents: 4 governance definitions, `staging:ticket-update`
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

## Deployment (CD, #100)

Deploys run from GitHub Actions (`.github/workflows/deploy.yml`, manual
`workflow_dispatch` with `environment: staging | production`):

1. The `check` workflow (static checks, model tests, dry-runs, full tests) runs on the exact
   commit (`workflow_call`).
2. The `deploy` job runs in the GitHub environment of the same name, so its protection rules
   apply. Configure **required reviewers** on `production`; production only deploys from
   `main`. Deploys to the same environment are serialized (`concurrency`).
3. `deploy:<environment>` applies D1 migrations, then deploys the Worker (migrate → deploy;
   migrations must be expand / contract compatible — docs/runbooks/migration-rollback.md).

Setup per GitHub environment (`staging`, `production`):

- secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token scoped to the account with
  _Workers Scripts: Edit_, _D1: Edit_, _Workers Queues: Edit_ (and Workflows) only. Source of
  truth: 1Password Environment `ultra-easy`.
- variable `CLOUDFLARE_ACCOUNT_ID`.

Local deploys with personal credentials are being phased out: use them only to bootstrap a new
environment or when GitHub Actions is unavailable, and record the revision in the incident /
release log.

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
