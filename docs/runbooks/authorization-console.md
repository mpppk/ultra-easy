# Authorization Administration Console (M9)

Parent: #116. Slices: #122 UI foundation, #117 read API, #118 governed mutation,
#119 console UI, #120 audit / E2E.

The console lets tenant admins inspect and operate authorization without the
Auth0 FGA Dashboard. Everything works through the OpenFGA-compatible REST API,
so switching to self-hosted OpenFGA keeps the UI/API contract.

## Access model

- Console authorization is itself FGA: tenant-scoped `authorization_admin:root`
  (provider object `authorization_admin:<org>/root`).
  - `viewer`: Explorer / Relationships / Model / Audit reads.
  - `editor` (implies `viewer`): `authorization.relationship.update` for
    Managed Relationship Catalog entries.
- The organization comes from the authenticated identity (Auth0 JWT, single
  staging org). Requests cannot select one, and machine (client-credentials)
  tokens are rejected for console routes.
- Admin check failures or provider errors fail closed (`503
authorization_admin_check_failed`), never allow.

## Admin membership bootstrap (IaC only)

`viewer` / `editor` membership is **never** changed from the console. The
Managed Relationship Catalog rejects every `authorization_admin:*` tuple.

1. Edit `packages/approval-fga/openfga/bootstrap/admins.json` (stable
   `user:<auth0 sub>` IDs only, never emails) and open a PR.
2. After merge, apply with the FGA credentials from 1Password (`ultra-easy`):

   ```sh
   op run --env-file=<fga env> -- bun packages/approval-fga/openfga/bootstrap-admins.ts staging --dry-run
   op run --env-file=<fga env> -- bun packages/approval-fga/openfga/bootstrap-admins.ts staging
   ```

   The script writes only missing tuples and never deletes.

3. Removal (off-boarding) is a manual, reviewed operation: delete the entry in
   `admins.json` via PR, then delete the tuple with the FGA API using the same
   credentials, and record the PR link in the incident/ops log.

Staging membership: alice = editor. bob intentionally has no console access
(the non-viewer principal for E2E).

## Authorization model (GitOps, console read-only)

- Source of truth: `packages/approval-fga/openfga/model.fga`. Model tests:
  `packages/approval-fga/openfga/store.fga.yaml`.
- CI runs `fga model test` (openfga/cli v0.8.0). A unit test keeps
  `AUTHORIZATION_MODEL_SOURCE` (the runtime copy used for the console's
  "matches Git source" check) in lockstep with the DSL.
- Changes are **additive-only**. Never remove or narrow a relation in place.
- Change procedure:
  1. PR editing `model.fga` + tests (+ `AUTHORIZATION_MODEL_SOURCE`).
  2. CI green (`vp check`, `bun run test`, `fga model test`).
  3. After merge, publish: `op run ... -- bun packages/approval-fga/openfga/publish-model.ts`.
     The script refuses non-additive changes and prints the new model ID.
  4. Pin `OPENFGA_AUTHORIZATION_MODEL_ID` in `apps/approval-api/wrangler.jsonc`
     (and the preview/runtime configs) via PR, deploy, and confirm the console
     Model view shows `matches Git source`.
- No worker has a model write path, and runtime credentials are never used to
  publish models.

## Managed Relationship Catalog

`DEFAULT_MANAGED_RELATIONSHIP_CATALOG` in
`packages/approval-core/src/authorization-admin.ts` is the server-side allow-list
of `objectType#relation` pairs the console may change (v1: `ticket#can_execute`,
`ticket#can_approve`).

To add an entry: PR adding the pair (the relation must already exist in the
published model) plus tests, then deploy. `authorization_admin` can never be added:
validation rejects it before the catalog is consulted.

## Explorer

`POST /v1/admin/authorization/explain` evaluates a complete Action (type,
resource, `action.input`) for a simulated principal through the same path as
a real submit, with no side effects. Missing or invalid input, a missing
attribute, a policy failure, or a provider outage returns `evaluation_error`,
never "no approval". OpenFGA proof graphs are not available, and the approval
flow shown is the Materialized Plan (not runtime progress).

## Governed relationship mutation (M9-2)

There is no direct tuple endpoint. Add/delete is an ActionRequest:

```http
POST /v1/organizations/{org}/action-requests
{ "action": { "type": "authorization.relationship.update",
              "resource": { "type": "authorization_admin", "id": "root" },
              "input": { "operation": "write" | "delete",
                         "tuple": { "user": "user:<sub>", "relation": "can_execute", "object": "ticket:T-1" } } } }
```

- Pipeline: schema (Managed Relationship Catalog) → Authorization (`editor`)
  → Approval Policy (if any) → Re-Authorization → executor
  `authorization` → D1 journal → OpenFGA → observe → confirm. Approval never
  overrides an editor deny. v1 carries 1 ActionRequest = 1 tuple.
- Staging policy `policy:staging-authorization-relationship`: granting
  `can_approve` needs bob's `security_approval`; other catalog changes need
  no approval.
- The executor idempotency key is the **mutation key**. A retried execution
  reuses the same revision, so there's no new revision and no duplicate audit.

### States

| mutation status | meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `prepared`      | intent + desired state + `requested` audit durable; provider not called yet        |
| `applying`      | latest revision is being applied (attempt count increments)                        |
| `confirmed`     | provider state observed equal to desired (only then is `change_confirmed` written) |
| `indeterminate` | provider effect unknown (network loss, timeout, 5xx, 429, read outage)             |
| `superseded`    | a newer revision of the same tuple exists; this one is never sent                  |
| `failed`        | provider rejected permanently (4xx) and the state does not match                   |

The relationship row's `sync_status` tracks the latest revision
(`prepared/applying/confirmed/indeterminate/failed`). An ActionRequest
`executed` only means the intent was recorded; `result.output.relationship.
effectConfirmed` tells whether the effect was observed.

### Reconciliation

- The approval-api cron (every minute) runs `reconcilePending` for the staging
  organization. It picks up `indeterminate` mutations immediately and
  `prepared` / `applying` ones idle for more than 60 s (crash or lost response).
- For each tuple it supersedes stale open revisions (no provider call),
  applies **only the latest** desired revision, and confirms after an exact
  higher-consistency read. It also repairs drift of a confirmed latest revision
  (`relationship_drift_repaired`), e.g. when a stale in-flight write landed
  late.
- `failed` is terminal and not retried automatically. Fix the cause, then
  submit a new ActionRequest.

### Troubleshooting

1. Find the tuple in Console → Relationships (filter by subject/object/sync
   status), or `GET /v1/admin/authorization/relationships?syncStatus=indeterminate`.
2. `GET /v1/admin/authorization/relationships/{tupleKey}?observe=true` shows
   the mutation journal (revision, status, attempts, error code) and the
   provider's observed state.
3. `indeterminate` / stuck `applying`: wait one cron tick. If it persists,
   check FGA health (`fga.read_latency_ms`, `fga.write_latency_ms`,
   `fga.error_total` in Workers Logs) and the `relationship reconcile failed`
   log. Reconciliation is idempotent and only ever sends the latest revision.
4. D1 and FGA disagree on a `confirmed` tuple (drift): the next reconciliation
   of that tuple repairs it. To force it, submit a new ActionRequest with the
   intended state. Never write the tuple directly, because the journal would
   no longer explain the provider state.
5. `superseded` is expected when changes overlap. The latest revision wins,
   and older retries never resurrect a revoked grant.

### Provider outage behavior

- Reads (Explorer / admin checks): fail closed. Explorer returns
  `evaluation_error` and admin routes return `503`.
- Mutations: the intent stays durable (`prepared` / `indeterminate`), no
  success is recorded, and the cron converges once the provider is back.

### Credential boundary

- The browser never sees FGA credentials. The web console proxies to
  approval-api.
- Tuple-write capability is constructed only in
  `apps/approval-api/src/relationship-mutation.ts` (executor + reconciler).
  Optional dedicated secrets are `FGA_TUPLE_WRITER_CLIENT_ID` /
  `FGA_TUPLE_WRITER_CLIENT_SECRET`, falling back to `FGA_CLIENT_ID/SECRET`
  in staging. The admin read API only receives read ports.
- No runtime component can write authorization models.

## Web console (M9-3)

Routes on the `ultra-easy` web worker: `/admin/authorization/{explorer,relationships,model,audit}`
(`/admin/authorization` redirects to Explorer), plus `/login`.

- The web worker proxies to approval-api over the `APPROVAL_API` service
  binding: `/api/admin/authorization/*` → `/v1/admin/authorization/*`, and
  `/api/action-requests[/:id]` → `/v1/organizations/{org}/action-requests[/:id]`,
  where the org is resolved server-side from the caller identity and only
  `authorization.relationship.update` may be created.
- Session: the Auth0 access token is stored AES-GCM encrypted in the
  `ue_console_session` cookie (HttpOnly, Secure, SameSite=Strict). Browser
  JavaScript never sees the token or any FGA credential. POSTs require the
  `x-ue-console: 1` header (CSRF).
- Staging sign-in uses the Auth0 password-realm grant (`STAGING_PASSWORD_LOGIN=true`)
  with the `ultra-easy-web` application. Universal Login is a follow-up.
- Secrets (`wrangler secret put` on `ultra-easy`, values from 1Password
  `ultra-easy`): `AUTH0_WEB_CLIENT_ID`, `AUTH0_WEB_CLIENT_SECRET`,
  `SESSION_SECRET` (random 32+ bytes). Rotating `SESSION_SECRET` signs
  everyone out.
- Local development: create `apps/web/.dev.vars` (gitignored) containing
  `SESSION_SECRET`, and run a worker named `ultra-easy-approval-api`
  (`wrangler dev`) so the dev registry resolves the binding.
- Explorer renders the simulation approval flow with React Flow + Dagre
  (read-only, graph on md+ screens) plus an equivalent keyboard-accessible
  tree, which is the only view on narrow screens. It is never runtime progress.

## Audit (M9-4)

- `GET /v1/admin/authorization/audit` (and Console → Audit) reads only the
  append-only `authorization_relationship_events` table. DB triggers reject
  UPDATE/DELETE, and the mutable relationship projection is never used as the
  audit source. Filters: actor, event, operation, subject, relation, object,
  ActionRequest, mutation key, revision, from/to, and an opaque cursor.
- Phases: `requested` (intent, durable before FGA), `apply_started`,
  `confirmed` (effect observed), `indeterminate`, `superseded`, `failed`,
  `drift_repaired`. The UI never presents requested or indeterminate as
  success.
- Payloads carry actor, time, tuple, source ActionRequest, mutation key and
  revision, desired state, model ID, and error code. They never carry the
  Action input body, decision comments, credentials, or PII display values.
  The correlation ID is the source ActionRequest ID.

## Break-glass

Emergency direct FGA tuple changes (IaC credentials, bypassing the console)
are allowed only to restore service or remove access during an incident, and
must be audited:

1. Record the incident ticket, operator, reason, and exact tuples before
   acting.
2. Prefer the console path (an ActionRequest with approval) whenever the
   console works. For console-managed tuples, afterwards submit an
   `authorization.relationship.update` with the same end state so the D1
   desired state and audit match the provider. Otherwise reconciliation will
   repair the provider back to the journal's desired state.
3. `authorization_admin` membership changes always go through
   `bootstrap/admins.json` + PR, including emergency removals, which may be
   applied first and reviewed post hoc within 24h.

## Staging E2E (AC-M9-011, 2026-09-24)

`op run --env-file=<refs> -- bun tests/staging/m9-authorization-console.e2e.ts`
against approval-api `25736a73` (model `01M38K1Q55CCNETS1V6XHJZJTB`),
run `m9-muf2he79`: **31/31 passed**:

- Read / Explorer: viewer reads and non-viewer 403; allowed / denied /
  approval-required; serial order (manager → finance); `ticket.escalate`
  fixture with any 1/2, all 2/2, quorum 2/3 and step metadata; missing input,
  invalid input, and provider error (invalid principal rejected by FGA) all
  return `evaluation_error`.
- Governed mutation: write with no approval → confirmed; `can_approve` grant
  → pending (FGA unchanged) → bob approves → Workflow → executor → confirmed;
  Check (Explorer + direct) reflects writes and deletes; editor revoked during
  approval → `authorization_revoked` with no mutation (membership restored);
  cross-org request 403 and object injection 422, with no foreign rows listed;
  admin `editor`/`viewer` and non-catalog relations → 422.
- Retry / ordering / crash: Idempotency-Key replay → same ActionRequest, 1
  mutation, 1 `requested`; A (grant applied, response lost) → B revoke
  confirmed → the cron reconciler supersedes A without resending, and the
  final state is revoke; FGA-success-then-crash intent stays durable and is
  confirmed by the cron; the ambiguous (unapplied) indeterminate mutation is
  applied and confirmed; concurrent write/delete gets revisions 1 and 2 and
  converges to the latest.
- Model read-only (pinned = GitOps, matches the Git source; PUT/POST/DELETE →
  404); audit carries actor, time, tuple, ActionRequest, and revision in
  requested → apply_started → confirmed order; superseded is visible; no input
  body or credentials.
- Web (`ultra-easy` worker): server-side login → encrypted session →
  `APPROVAL_API` binding → session, relationships, Explorer (any/all/quorum),
  and model all verified. Anonymous → 401, POST without the console header → 403.
