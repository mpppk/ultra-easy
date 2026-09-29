# Production Workflow Studio (#192)

## Composition and storage

`apps/approval-api` hosts `WorkflowPlatform`, `WorkflowRunner`, and `ActionWorkflow`.
The platform's ActionRequest service and executor registry serve both the public
ActionRequest API and Workflow runs, so child Actions use the same authorization,
approval, and audit pipeline. `WORKFLOW_RUNNER` starts and resumes durable runs;
the scheduled `sweep_workflow_runs` task recovers due runs after a failed start or
handoff. `AI` supplies Workers AI to the LLM effect and Program authoring.
`DEFAULT_RESOURCE_LIMITS` enforces D1-backed run and effect quotas.

The approval D1 migration sequence already includes Workflow tables in
`0021_workflow_runtime.sql` through `0025_workflow_governance.sql`. Both staging
and production use `apps/approval-api/wrangler.jsonc` with
`packages/approval-d1/migrations`; apply migrations before deploying the Worker.
The production D1 database and Auth0/FGA settings must be provisioned as
described in [production-api.md](production-api.md) before `--env production`
can serve requests. Missing settings fail closed with `configuration_invalid`.

## Routes and access

The browser uses `/workflows`, `/workflows/:id`, and `/workflow-runs/:runId`.
Its API is `/api/workflow/*`; the web Worker reads the encrypted HttpOnly console
session and sends its bearer token through the `APPROVAL_API` service binding to
`/v1/admin/workflow/*`. The browser does not receive the token. Writes require
the `x-ue-console: 1` CSRF header. The API validates the Auth0 user token and
deployment organization; machine principals and other tenants are rejected.
GET operations require `authorization_admin:root#viewer`; POST and PUT require
`authorization_admin:root#editor`. Provider errors fail closed. Organization IDs
are taken only from the verified identity, never request input.

| Path below `/v1/admin/workflow`                                                                                               | Method | Operation                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `/catalog`, `/definitions`, `/definitions/:id`, `/programs`, `/runs`, `/runs/:id`, `/actions/:id`                             | GET    | Read catalog, definitions, programs, runs, and action status |
| `/definitions/:id/validate`, `/definitions/:id/publish`, `/definitions/:id/projection`                                        | POST   | Validate, publish, or project a definition                   |
| `/definitions/:id`                                                                                                            | PUT    | Save a draft with an expected revision                       |
| `/programs/draft`, `/programs/publish`, `/runs`, `/runs/:id/advance`, `/runs/:id/cancel`, `/runs/:id/effects/:effectId/input` | POST   | Author a Program or start and control a run                  |

`POST /bootstrap` and `POST /actions/:id/decision` are preview-only and return
404 on this route. Production approval decisions use the governed public API.
Composite ActionRequests on `workflow_subject` require a published Composite
Action and `authorization_admin:root#editor` in the Action Authorizer as well.
Unmapped Actions remain denied. Published Workflow versions are immutable.

The `/preview/*` UI and API remain behind `PREVIEW_HARNESS_ENABLED` and their
preview token. In the normal web deployment, the preview API returns 404.
