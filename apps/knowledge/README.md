# Knowledge Workspace (example app, #167)

A SharePoint / Confluence–style knowledge base built as an **independent application** on top of ultra-easy.
Everyday use is browse / search / read / edit. ultra-easy only shows up where governance is needed:
publishing, archiving, post-publish side effects and document maintenance.

```text
apps/knowledge/           TanStack Start + Cloudflare Worker (UI, HTTP API, /mcp)
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

## MCP endpoint

`POST /mcp` (Streamable HTTP, protocol revision `2026-07-28`, same contract as the ultra-easy MCP Gateway's
downstream client). Requires `Authorization: Bearer $KNOWLEDGE_MCP_TOKEN`. Tools:
`knowledge.revision.publish`, `knowledge.search.reindex`, `knowledge.watchers.notify`,
`knowledge.pages.list_stale`, `knowledge.page.mark_reviewed`, `knowledge.page.archive` (+ read-only
`knowledge.publication.get`, `knowledge.page.get_published`). Mutating tools advertise
`guaranteeLevel=idempotent` and deduplicate by idempotency key in `tool_invocations`.

## Running locally

```bash
vp install
vp -C apps/knowledge run db:migrate:local   # both local D1 databases
vp -C apps/knowledge run dev                # http://localhost:3001
```

Sign in at `/login` with a demo principal (seeded on first request):

| Principal | Engineering | Other spaces                         |
| --------- | ----------- | ------------------------------------ |
| Yuki M.   | owner       | Product editor, HR / Handbook viewer |
| Morgan T. | owner       | Handbook owner                       |
| Alex K.   | editor      | Product viewer                       |
| Sam L.    | viewer      | HR viewer                            |
| Hana S.   | —           | Product / HR owner                   |
| Riley P.  | —           | none (organization-wide pages only)  |

The user menu has local demo controls: switch principal, simulate notifier / search-index outages.

Tests: `vp -C apps/knowledge test` (API scenario + UI foundation), `vp -C apps/knowledge run test:e2e`
(Playwright on a fresh local D1; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to reuse an installed Chromium).

## Configuration

| Name                                     | Meaning                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `KNOWLEDGE_AUTH_MODE`                    | `demo` (fixture principals). `auth0` is not wired yet and fails closed. |
| `ULTRA_EASY_MODE`                        | `mock` (only implementation today).                                     |
| `KNOWLEDGE_ORGANIZATION_ID`              | organization of the workspace (`org_acme`).                             |
| `SESSION_SECRET` / `KNOWLEDGE_MCP_TOKEN` | secrets; demo mode falls back to well-known local values.               |

D1 databases are auto-provisioned on the first `wrangler deploy` (`bootstrap` script), then migrations run before
every deploy (`deploy` script).

## Not in this MVP

Auth0 sign-in (demo principals only), the real ultra-easy public API / Service Binding, a scheduler trigger for
maintenance (manual "Run maintenance"), rich-text / collaborative editing, semantic search.
