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
  `staging-alice@example.com` / `staging-bob@example.com`).
  NOTE: their passwords were not persisted to 1Password (create attempts
  failed silently). Reset them via the Auth0 dashboard (Users → user →
  Reset Password) and store them as `AUTH0_STAGING_*_PASSWORD` in the
  `ultra-easy` vault BEFORE running the next staging E2E.
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

- Store `01M31PMZ0DRBWZQ9D6TZ64E87W` (US), model with `ticket`
  (`can_execute`/`can_approve` by `user`).
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
D1 (see `docs/runbooks/operator-dashboard.md`). Cron evaluates alerts.

## Known gaps (follow-ups, not M8-1)

- Browser login UI + session management (M2M + password-realm only).
- `action.received` is not emitted on the v1 submit path, so lead-time SLI
  stays null on production data (completed/dwell work).
- Custom domain + ultra-easy-web callback URLs.
- Staging executor is a success-echo sink (no external side effects by design).
