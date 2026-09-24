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
