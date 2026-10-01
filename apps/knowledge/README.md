# Knowledge Workspace (example app, #167)

A SharePoint / Confluence–style knowledge base built as an **independent application** on top of ultra-easy.
Everyday use is browse / search / read / edit. ultra-easy only shows up where governance is needed:
publishing, archiving, post-publish side effects and document maintenance.

```text
apps/knowledge/           TanStack Start + Cloudflare Worker (UI, HTTP API, /mcp)
  src/server.ts           Worker entry: TanStack Start fetch + weekly maintenance Cron Trigger
  src/routes/             7 MVP screens + Space Settings (post-MVP screen 8) + /mcp + /api/*
  src/server/             KnowledgeService (authorized projections), API router, session, seed
  src/mcp/                Streamable HTTP MCP endpoint + primitive Knowledge Actions
  src/ultra-easy/         the ONLY integration point with ultra-easy (client.ts)
    mock/                 in-app stand-in for ultra-easy (see "ultra-easy mock" below)
  ultra-easy-mock/        D1 migrations of the mock platform (separate database)
  e2e/                    Playwright scenario
packages/knowledge-core/  domain: capabilities, projections, snapshot validation, lifecycle CAS
packages/knowledge-d1/    D1 migrations (incl. FTS5) + repositories
```

## Screens

| #   | Screen                    | Route                                  |
| --- | ------------------------- | -------------------------------------- |
| 1   | Home                      | `/`                                    |
| 2   | Spaces                    | `/spaces`                              |
| 3   | Space Detail              | `/spaces/:spaceKey`                    |
| 4   | Page View                 | `/spaces/:spaceKey/pages/:pageId`      |
| 5   | Page Edit                 | `/spaces/:spaceKey/pages/:pageId/edit` |
| 6   | Search                    | `/search?q=&space=&tag=`               |
| 7   | Automation                | `/automation?tab=&run=`                |
| 8   | Space Settings (post-MVP) | `/spaces/:spaceKey/settings`           |

Revision history is a drawer in Page View (`?revision=N` opens a revision); automation run detail is a side panel
in Automation. There is no approval inbox: "View approval" deep-links to the ultra-easy Approval UI.

## Key invariants

- **Draft saves never create ActionRequests.** Only Knowledge D1 is written.
- **Publish pins an immutable PublicationSnapshot** (revision + visibility + sensitivity + expected lifecycle
  version). Revisions and snapshots are INSERT-only (DB triggers reject UPDATE / DELETE).
- **Lifecycle CAS**: `knowledge.revision.publish` updates the page only if `lifecycle_version` still matches;
  newer publications and archive win, old pending publications end as `publication_conflict`. A replay of the
  same snapshot is recognised and is not a conflict.
- **Published vs authoring content** are separate projections everywhere (Home, Space Detail, Search,
  backlinks, related pages, history). Authorization scope is bound into every SQL query (no fetch-then-filter);
  published and draft text live in separate FTS5 indexes.
- **Domain state ≠ automation state**: a failed notification leaves the page published; only the failed
  effect is retried, as a new ActionRequest. The original run keeps its failed history.

## Scheduled maintenance

`knowledge.maintain_space` runs weekly for every space (Cron Trigger `0 0 * * 1`, Mondays 00:00 UTC, in
`wrangler.jsonc`) as well as from the manual "Run maintenance" button. Both go through
`startSpaceMaintenance` (`src/server/maintenance.ts`), so they start the same Workflow Definition:

- a space whose maintenance run is still running / waiting for input or approval is skipped;
- the idempotency key is scoped to the space and week, so a redelivered Cron event starts nothing new;
- scheduled runs are requested by the trigger principal `trigger:knowledge-maintenance-weekly`, which ultra-easy
  authorizes for `knowledge.maintain_space` and its child actions only. It is never a space member or an
  approval candidate; owner review and archive approval stay with the page owners.

The Cron Trigger is interim until the ultra-easy Workflow scheduler / Timer Trigger is public. Try it locally
with `curl "http://localhost:3001/cdn-cgi/handler/scheduled?cron=0+0+*+*+1"` while `vp dev` runs.

## ultra-easy integration and the mock

`src/ultra-easy/client.ts` is the public surface Knowledge needs: authorization relationships, ActionRequests /
Composite Actions, run projections, Human Input and governed policy bindings. The Workflow Engine public API is
still being built (#154–#165), so `ULTRA_EASY_MODE=mock` uses `src/ultra-easy/mock`:

- keeps its own D1 database (`ULTRA_EASY_MOCK_DB`) — no workflow state is stored in Knowledge tables;
- runs `knowledge.publish_document` (analysis → child `knowledge.revision.publish` with Authorization →
  Approval → Re-Authorization → execution → reindex / notify) and `knowledge.maintain_space` (list stale →
  ForEach LLM freshness analysis → branch → durable Human Input / archive with approval);
- executes every child action by calling the Knowledge **MCP endpoint** (`tools/call` with
  `dev.ultra-easy/idempotencyKey`), exactly like the MCP Gateway's downstream executor;
- evaluates the seeded approval policy (confidential or organization-wide publication → space owners;
  archive requested by someone other than the page owner → page owner). Self-approval is not allowed;
- uses a deterministic LLM stand-in whose output is only a suggestion (never skips approval);
- serves a minimal Approval UI at `/mock/ultra-easy/approvals/:taskId`, outside the Knowledge shell.

Replacing the mock with a Service Binding / HTTP client only means implementing `UltraEasyClient`.
The first remote slice (#213) is `src/ultra-easy/remote/authorization.ts`: construct it
per verified user session with that session's API access token and principal ID.
Pass a Knowledge M2M agent token provider for the governed initial space owner grant.
It reads every cursor page and requires confirmed FGA effect for a grant. Runtime
`ULTRA_EASY_MODE=remote` remains gated until the remaining policy methods and
request-scoped runtime wiring are implemented (#183).

The second remote slice (#216) is `src/ultra-easy/remote/workflow.ts`. Construct it
per verified user or agent token with the matching principal ID. It submits
Catalog actions against `knowledge_space`, reads run projections, and answers
Human Input as the bound user. A primitive ActionRequest or one awaiting approval
can have no run; `startAction` returns `run: null` with the ActionRequest status,
and Knowledge stores the ActionRequest ID for later lookup. Run list filters can
include at most 100 spaces per request; the adapter chunks larger space sets and
returns up to 100 recent visible runs. The public run list has no cursor yet.
Cancellation (#217) uses the same client and accepts the original actor's token.

## MCP endpoint

`POST /mcp` (Streamable HTTP, protocol revision `2026-07-28`, same contract as the ultra-easy MCP Gateway's
downstream client). Requires `Authorization: Bearer $KNOWLEDGE_MCP_TOKEN`. Tools:
`knowledge.revision.publish`, `knowledge.search.reindex`, `knowledge.watchers.notify`,
`knowledge.pages.list_stale`, `knowledge.page.mark_reviewed`, `knowledge.page.archive` (+ read-only
`knowledge.publication.get`, `knowledge.page.get_published`). Mutating tools advertise
`guaranteeLevel=idempotent` and deduplicate by idempotency key in `tool_invocations`.

ultra-easy registers these tools as `knowledge.*` Actions in its Application Catalog
(`docs/application-catalog.md`, #198) and authorizes them per space. The ultra-easy route always
passes the authorized space as `spaceId`, so tools reject a page or snapshot of another space
(`resource_outside_space`). They also reject policy fields that differ from the real values
(`visibility` / `sensitivity` of the snapshot, the page owner as `pageOwnerId`).

## Running locally

```bash
vp install
vp -C apps/knowledge run db:migrate:local   # both local D1 databases
vp -C apps/knowledge run dev                # http://localhost:3001
```

`vp dev` runs in demo mode: sign in at `/login` with a demo principal (seeded on first request):

| Principal | Engineering | Other spaces                         |
| --------- | ----------- | ------------------------------------ |
| Yuki M.   | owner       | Product editor, HR / Handbook viewer |
| Morgan T. | owner       | Handbook owner                       |
| Alex K.   | editor      | Product viewer                       |
| Sam L.    | viewer      | HR viewer                            |
| Hana S.   | —           | Product / HR owner                   |
| Riley P.  | —           | none (organization-wide pages only)  |

The user menu has local demo controls: switch principal, simulate notifier / search-index outages.

## Sign-in (Auth0)

Deployed, the Worker runs with `KNOWLEDGE_AUTH_MODE=auth0` (`wrangler.jsonc`). Demo mode is switched on only by
the local dev server (`vite.config.ts` overrides the var for `vp dev`), so every `/api/demo/*` endpoint returns 404
and the principal switcher / fault toggles are hidden in a deployment.

- `/login` → `GET /api/auth/login` → Auth0 Universal Login (Authorization Code + PKCE, `state` and `nonce` kept in
  a 10-minute encrypted `SameSite=Lax` cookie scoped to `/api/auth`).
- `GET /api/auth/callback` checks `state`, exchanges the code (confidential client), verifies the ID token (RS256,
  tenant JWKS, `iss`, `aud`, `nonce`) and the organization membership, then seals `user:<sub>` (same mapping as
  approval-api) into the encrypted HttpOnly `SameSite=Strict` session. The principal and organization come from the
  verified token and the deployment config only, never from the browser.
- The user is registered in the ultra-easy principal directory on sign-in (JIT). That grants nothing: space
  access still comes from ultra-easy relationships (creating a space makes you its owner).
- `POST /api/auth/logout` clears the session and returns the Auth0 logout URL.

Auth0 setup: a Regular Web Application on the tenant with Allowed Callback URL
`https://<host>/api/auth/callback` and Allowed Logout URL `https://<host>/login`. Organization membership is
verified like approval-api: `AUTH0_ORGANIZATION_CLAIM_VALUE` (+ `AUTH0_ORGANIZATION_CLAIM`, default `org_id`; also
sent as `organization` to `/authorize`) or `AUTH0_TENANT_IS_ORGANIZATION=true` for a single-organization tenant
with public signup disabled. To try Auth0 locally, put the secrets in `apps/knowledge/.dev.vars`, run
`KNOWLEDGE_AUTH_MODE=auth0 vp -C apps/knowledge run dev` and allow `http://localhost:3001/api/auth/callback`.

Tests: `vp -C apps/knowledge test` (API scenario + UI foundation), `vp -C apps/knowledge run test:e2e`
(Playwright on a fresh local D1; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to reuse an installed Chromium).

## Configuration

| Name                                                              | Meaning                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `KNOWLEDGE_AUTH_MODE`                                             | `auth0` (deployed). `demo` only via the local dev server. Unset fails closed.   |
| `AUTH0_DOMAIN`                                                    | Auth0 tenant domain (var).                                                      |
| `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET`                         | Regular Web Application credentials (secrets).                                  |
| `AUTH0_API_AUDIENCE`                                              | approval API audience (`https://ultra-easy/approval-api`).                      |
| `AUTH0_AGENT_CLIENT_ID` / `AUTH0_AGENT_CLIENT_SECRET`             | Knowledge M2M Application credentials for weekly maintenance (secrets).         |
| `AUTH0_ORGANIZATION_CLAIM_VALUE` / `AUTH0_TENANT_IS_ORGANIZATION` | organization membership check (one is required in `auth0` mode).                |
| `ULTRA_EASY_MODE`                                                 | `mock` (only implementation today).                                             |
| `KNOWLEDGE_ORGANIZATION_ID`                                       | organization of the workspace (`org_acme`).                                     |
| `SESSION_SECRET` (32+ chars) / `KNOWLEDGE_MCP_TOKEN`              | secrets; required in `auth0` mode (demo falls back to well-known local values). |

## Deployment

Deployed at <https://ultra-easy-knowledge.niboshi.workers.dev> (Worker `ultra-easy-knowledge`, first deployed for
#185). It always runs `KNOWLEDGE_AUTH_MODE=auth0`; until the Auth0 client secrets exist every endpoint answers
`503 misconfigured` (fail closed), and the demo endpoints never exist there.

- First deploy (done once): `vp -C apps/knowledge run bootstrap` auto-provisions `KNOWLEDGE_DB` /
  `ULTRA_EASY_MOCK_DB` on `wrangler deploy`, then applies both migration sets.
- Secrets (`wrangler secret put`, keep them in 1Password `ultra-easy`): `SESSION_SECRET` (32+ chars) and
  `KNOWLEDGE_MCP_TOKEN` are set; rotating them only signs everyone out / changes the internal MCP token.
  `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` come from the Auth0 Regular Web Application (callback
  `https://ultra-easy-knowledge.niboshi.workers.dev/api/auth/callback`, logout `…/login`).
  It needs user access to the approval API with `read:action-requests` and `write:action-requests`.
  `AUTH0_AGENT_CLIENT_ID` / `AUTH0_AGENT_CLIENT_SECRET` come from a separate M2M Application with
  client credentials access to the same API and scopes. The API registry must include both client IDs.
  Login stores the verified API access token in the encrypted session cookie. The cookie expires with
  that token; no refresh token is requested. Weekly maintenance uses the verified M2M agent principal.
- CD: run the **deploy-knowledge** workflow (Actions tab, `main` only). It reruns `check.yml` on the commit, then
  `vp -C apps/knowledge run deploy` (migrate → deploy) with the `staging` GitHub environment's
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`. Migrations must stay backward compatible with the running
  revision.

## Not in this MVP

The real ultra-easy public API / Service Binding, rich-text / collaborative editing, semantic search.
