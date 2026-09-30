import { Result } from "@praha/byethrow";

import {
  authenticatePublicApi,
  authorizePublicAction,
  loadReadableActionRequest,
  matchHttpRoute,
  type ApprovalReadRepository,
  type PublicApiOperatorAccess,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import { parseBrand, type OrganizationId, type PrincipalRef } from "@app/approval-core";
import { parseWorkflowId } from "@app/workflow-core";
import { allRows } from "@app/workflow-d1";
import type { D1DatabaseLike } from "@app/workflow-d1";
import type { WorkflowRunRecord } from "@app/workflow-application";

import type { WorkflowPlatform } from "./platform.ts";
import { projectPublicWorkflowRun, type PublicWorkflowRunView } from "./public-run-projection.ts";

export const PUBLIC_WORKFLOW_RUN_ROUTES = [
  "/v1/organizations/{organizationId}/workflow-runs",
  "/v1/organizations/{organizationId}/workflow-runs/{runId}",
  "/v1/organizations/{organizationId}/action-requests/{actionRequestId}/workflow-run",
] as const;

type RunKeyRow = { run_id: string; parent_action_request_id: string; created_at: string };

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function repositoryProblem(error: { code: string; retriable: boolean }): Response {
  return problem(error.retriable ? 503 : 500, error.code, "Workflow Runを読み取れません");
}

function runNotFound(): Response {
  return problem(404, "workflow_run_not_found", "Workflow Run not found");
}

function parseListQuery(url: URL): { limit: number; key?: string; values: string[] } | Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return problem(400, "invalid_limit", "limitが不正です");
  }
  const key = url.searchParams.get("correlationKey");
  const values = url.searchParams.getAll("correlationValue");
  if (
    (key === null) !== (values.length === 0) ||
    (key !== null && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) ||
    values.length > 100 ||
    values.some(
      (value) =>
        value.length < 1 ||
        value.length > 255 ||
        Array.from(value).some((character) => character.charCodeAt(0) < 32),
    )
  ) {
    return problem(400, "invalid_correlation_filter", "correlation filterが不正です");
  }
  return { limit, ...(key !== null ? { key } : {}), values };
}

async function runBatch(input: {
  db: D1DatabaseLike;
  organizationId: OrganizationId;
  key?: string;
  values: string[];
  cursor: { createdAt: string; runId: string } | null;
}): ReturnType<typeof allRows<RunKeyRow>> {
  return allRows<RunKeyRow>(
    input.db
      .prepare(
        `SELECT wr.run_id, wr.parent_action_request_id, wr.created_at
           FROM workflow_runs wr
           JOIN action_requests a
             ON a.organization_id = wr.organization_id AND a.id = wr.parent_action_request_id
          WHERE wr.organization_id = ?
            AND (? = 0 OR json_extract(a.correlation_json, ?) IN (SELECT value FROM json_each(?)))
            AND (? IS NULL OR wr.created_at < ? OR (wr.created_at = ? AND wr.run_id < ?))
          ORDER BY wr.created_at DESC, wr.run_id DESC
          LIMIT 100`,
      )
      .bind(
        String(input.organizationId),
        input.key ? 1 : 0,
        input.key ? `$.${input.key}` : "$.unused",
        JSON.stringify(input.values),
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.runId ?? null,
      ),
  );
}

export function createPublicWorkflowRunApi(input: {
  db: D1DatabaseLike;
  platform: WorkflowPlatform;
  readRepository: ApprovalReadRepository;
  identityProvider: PublicHttpIdentityProvider;
  operatorAccess?: PublicApiOperatorAccess;
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  async function authorizedParent(
    request: Request,
    organizationId: OrganizationId,
    actionRequestId: string,
    viewer: PrincipalRef,
  ) {
    const parsed = parseBrand("ActionRequestId", actionRequestId);
    if (Result.isFailure(parsed))
      return problem(400, "invalid_action_request_id", "ActionRequest IDが不正です");
    const loaded = await loadReadableActionRequest({
      organizationId,
      actionRequestId: parsed.value,
      viewer,
      readRepository: input.readRepository,
      ...(input.operatorAccess ? { operatorAccess: input.operatorAccess } : {}),
    });
    if (loaded instanceof Response) return loaded;
    const restricted = await authorizePublicAction({
      identityProvider: input.identityProvider,
      request,
      organizationId,
      operation: "action_request.read",
      action: loaded,
    });
    return restricted ?? loaded;
  }

  async function project(
    record: WorkflowRunRecord,
    parent: Awaited<ReturnType<typeof authorizedParent>>,
  ) {
    if (parent instanceof Response) return parent;
    const view = await projectPublicWorkflowRun({
      db: input.db,
      platform: input.platform,
      readRepository: input.readRepository,
      organizationId: record.state.organizationId,
      record,
      parent,
    });
    return Result.isFailure(view) ? repositoryProblem(view.error) : view.value;
  }

  return {
    handles(request: Request): boolean {
      return (
        request.method === "GET" &&
        matchHttpRoute(PUBLIC_WORKFLOW_RUN_ROUTES, new URL(request.url).pathname) !== null
      );
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const matched = matchHttpRoute(PUBLIC_WORKFLOW_RUN_ROUTES, url.pathname);
      if (request.method !== "GET" || !matched) return runNotFound();
      if (
        (matched.route.endsWith("/{runId}") && matched.parameters["runId"] === undefined) ||
        (matched.route.endsWith("/{actionRequestId}/workflow-run") &&
          matched.parameters["actionRequestId"] === undefined)
      ) {
        return problem(400, "invalid_path_parameter", "path parameterが不正です");
      }
      const organization = parseBrand("OrganizationId", matched.parameters["organizationId"]);
      if (Result.isFailure(organization))
        return problem(400, "invalid_organization_id", "Organization IDが不正です");
      const organizationId = organization.value;
      const viewer = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: "action_request.read",
      });
      if (viewer instanceof Response) return viewer;

      if (matched.parameters["runId"] !== undefined) {
        const runId = parseWorkflowId("WorkflowRunId", matched.parameters["runId"]);
        if (Result.isFailure(runId))
          return problem(400, "invalid_workflow_run_id", "Workflow Run IDが不正です");
        const loaded = await input.platform.repositories.runs.load({
          organizationId,
          runId: runId.value,
        });
        if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
        const parentId = loaded.value?.invocation.parentAction?.actionRequestId;
        if (!loaded.value || !parentId) return runNotFound();
        const parent = await authorizedParent(request, organizationId, String(parentId), viewer);
        if (parent instanceof Response && parent.status === 404) return runNotFound();
        const result = await project(loaded.value, parent);
        return result instanceof Response ? result : Response.json(result);
      }

      if (matched.parameters["actionRequestId"] !== undefined) {
        const parent = await authorizedParent(
          request,
          organizationId,
          matched.parameters["actionRequestId"],
          viewer,
        );
        if (parent instanceof Response) return parent.status === 404 ? runNotFound() : parent;
        const loaded = await input.platform.repositories.runs.findByParentAction({
          organizationId,
          actionRequestId: parent.id,
        });
        if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
        if (!loaded.value) return runNotFound();
        const result = await project(loaded.value, parent);
        return result instanceof Response ? result : Response.json(result);
      }

      const query = parseListQuery(url);
      if (query instanceof Response) return query;
      const items: PublicWorkflowRunView[] = [];
      let cursor: { createdAt: string; runId: string } | null = null;
      while (items.length < query.limit) {
        const batch = await runBatch({
          db: input.db,
          organizationId,
          ...(query.key ? { key: query.key } : {}),
          values: query.values,
          cursor,
        });
        if (Result.isFailure(batch)) return repositoryProblem(batch.error);
        if (batch.value.length === 0) break;
        for (const row of batch.value) {
          cursor = { createdAt: row.created_at, runId: row.run_id };
          const parent = await authorizedParent(
            request,
            organizationId,
            row.parent_action_request_id,
            viewer,
          );
          if (parent instanceof Response) {
            if (parent.status === 403 || parent.status === 404) continue;
            return parent;
          }
          const runId = parseWorkflowId("WorkflowRunId", row.run_id);
          if (Result.isFailure(runId))
            return repositoryProblem({ code: "workflow_stored_id_invalid", retriable: false });
          const loaded = await input.platform.repositories.runs.load({
            organizationId,
            runId: runId.value,
          });
          if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
          if (!loaded.value)
            return repositoryProblem({ code: "workflow_run_disappeared", retriable: true });
          const result = await project(loaded.value, parent);
          if (result instanceof Response) return result;
          items.push(result);
          if (items.length >= query.limit) break;
        }
        if (batch.value.length < 100) break;
      }
      return Response.json({ items });
    },
  };
}
