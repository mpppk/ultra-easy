# Approval Runtime Preview Environment

## Architecture

```text
Web branch preview (`ultra-easy` version)
  /preview/approval-runtime
  /api/preview/approval-runs/*
          |
          | Service Binding: APPROVAL_RUNTIME_PREVIEW
          v
Private stable Worker: ultra-easy-approval-runtime-preview
          |
          +-- D1: DB
          +-- Workflow: ACTION_WORKFLOW / ActionWorkflow
          +-- self Service Binding: ACTION_AUTHORIZER -> PreviewActionAuthorizer
          +-- self Service Binding: ACTION_EXECUTOR -> PreviewActionExecutor
```

The Web preview does not bind D1 or Workflows directly. The stable runtime Worker owns both resources and exposes a private HTTP gateway that is only reachable through a Cloudflare Service Binding.

The M5 Preview mock Authorizer / Executor are named entrypoints on the same private Worker. They are reached only through Service Bindings, so the Preview path exercises the same `ServiceBindingActionAuthorizer` / `ServiceBindingActionExecutor` contracts as a real application integration without adding public mock endpoints.

Production `apps/web/wrangler.jsonc` is unchanged. The harness is enabled only by `apps/web/wrangler.preview.jsonc`, where `PREVIEW_HARNESS_ENABLED=true`.

## 1. Deploy the stable preview runtime

Create a Worker in Cloudflare Workers Builds connected to this repository with the Worker name:

```text
ultra-easy-approval-runtime-preview
```

Use `main` as the production branch and disable non-production branch builds for this Worker. From the repository root, use the following deploy command:

```bash
vp -C apps/approval-runtime run deploy:preview
```

The runtime Wrangler configuration declares a draft D1 binding (`DB`) without an account-specific resource ID. Wrangler automatic provisioning creates and links the D1 database on the first deploy, so the very first deploy must use `vp -C apps/approval-runtime run bootstrap:preview` (deploy → migrate). After that, `deploy:preview` applies `packages/approval-d1/migrations` first and then deploys (migrate → deploy, #100; migrations must be expand / contract compatible, see `docs/runbooks/migration-rollback.md`).

The Worker has `workers_dev=false`, so it is not intended to expose a public `workers.dev` endpoint. It is consumed by the Web Worker through a Service Binding.

The first Preview scenarios use direct user targets only. The OpenFGA variables in this Worker are therefore inert placeholders; dynamic OpenFGA scenarios are intentionally deferred. Re-Authorization still runs through the Preview ActionAuthorizer Service Binding before every Action execution.

## 2. Configure Web branch previews

Keep the existing `ultra-easy` Worker and its production configuration, and enable non-production branch builds.

No custom build environment variable is required. Workers Builds injects `WORKERS_CI_BRANCH`; `apps/web/vite.config.ts` selects `wrangler.preview.jsonc` automatically when the branch is not `main`. The production branch continues to use `wrangler.jsonc`.

The regular build command can remain unchanged. During a preview build, the Cloudflare Vite plugin reads `wrangler.preview.jsonc` and generates the deployment configuration containing:

- `PREVIEW_HARNESS_ENABLED=true`
- Service Binding `APPROVAL_RUNTIME_PREVIEW -> ultra-easy-approval-runtime-preview`

Use the normal non-production deploy command:

```bash
npx wrangler versions upload
```

The generated Wrangler configuration from the Vite build is automatically used by `wrangler versions upload`.

For local/CI verification, the equivalent commands are:

```bash
vp -C apps/web run build:preview
vp -C apps/approval-runtime run deploy:dry-run
```

Both commands are also executed by the repository check workflow so Preview-specific configuration drift fails CI before merge.

## 3. Protect Preview URLs

Worker version Preview URLs are **public** unless protected. Without protection anyone who
finds the URL could start runs, send decisions as an arbitrary `userId`, and force-cancel with an
arbitrary `actor`, which pollutes the force-cancel audit (#97). Two layers apply:

1. **Shared token (enforced by the app).** Every `/api/preview/*` handler requires the header
   `x-preview-harness-token` to match the Worker secret `PREVIEW_HARNESS_TOKEN` (constant-time
   comparison). Missing / wrong token → 401; secret not set → 403 `preview_harness_locked`, so a
   fresh preview is locked until the secret exists. Set it once on the `ultra-easy` Worker (preview
   versions share Worker secrets; production ignores it because the harness is disabled there):

   ```bash
   op read op://ultra-easy/PREVIEW_HARNESS_TOKEN/password | npx wrangler secret put PREVIEW_HARNESS_TOKEN
   ```

   The preview pages ask for the token (kept in `sessionStorage` only) and send it with each call.

2. **Cloudflare Access (recommended).** Enable Access on Workers Preview URLs for the `ultra-easy`
   Worker (Workers & Pages → ultra-easy → Settings → Domains & Routes → Preview URLs → Enable
   Cloudflare Access) so the pages themselves are not reachable anonymously.

The application also fails closed in production: `/api/preview/*` returns 404 unless `PREVIEW_HARNESS_ENABLED` is exactly `true`.

Do not add `PREVIEW_HARNESS_ENABLED=true` to the production Wrangler configuration.

## 4. Smoke test

Open the branch Preview URL at:

```text
/preview/approval-runtime
```

### Approvalなし

Start with `no-approval`, then refresh until the Workflow completes.

Expected progression:

```text
start
  -> Runtime approved
  -> Re-Authorization allow
  -> Preview ActionExecutor
  -> Workflow complete
  -> Action result executed
```

Verify that:

- Guarantee is `best_effort_at_most_once`.
- Idempotency key is present in the Action Result projection.
- The executor output recorded in `action_results` contains the same idempotency key.

### Approvalあり

Next run `serial-two-users`.

Expected progression:

```text
start
  -> Workflow running/waiting
  -> Runtime pending
  -> manager task pending (user:alice)

Approve as user:alice
  -> manager approved
  -> finance task pending (user:bob)

Approve as user:bob
  -> Runtime approved
  -> Re-Authorization allow
  -> Preview ActionExecutor
  -> Workflow complete
  -> Action result executed
```

The final Action Result must again show `best_effort_at_most_once` and an idempotency key. This demonstrates that Approvalあり/なしの両方が同じ ActionExecutor contract へ収束する。

Then verify the approval semantics scenarios:

- `parallel-all`
- `parallel-quorum`
- `distinct-approvers`

The status endpoint intentionally returns the Cloudflare Workflow status, D1 approval runtime projection, and D1 Action Result projection so mismatches between durable execution and either read projection are visible.

## Follow-up

After the direct-user Preview path is stable, add a Preview OpenFGA environment and cover dynamic approvers, self-approval constraints, and resolver failure/retry behavior.
