import { Result } from "@praha/byethrow";

import type {
  AuthorizationAdminAccessChecker,
  AuthorizationAdminCallerResolver,
} from "@app/approval-application";
import type { OrganizationId } from "@app/approval-core";
import type { CapabilityPolicy } from "@app/workflow-application";
import { handleWorkflowStudio, type WorkflowPlatform } from "@app/workflow-platform";

export const PRODUCTION_WORKFLOW_STUDIO_PREFIX = "/v1/admin/workflow";

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { status, code, title },
    {
      status,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    },
  );
}

/** All Studio operations use the deployment's organization and a verified human identity. */
export function createProductionWorkflowStudioApi(input: {
  env: { DB: D1Database; AI?: unknown };
  platform: WorkflowPlatform;
  capabilityPolicy: CapabilityPolicy;
  llmModel: string;
  identity: AuthorizationAdminCallerResolver;
  access: AuthorizationAdminAccessChecker;
  organizationId: OrganizationId;
}) {
  return {
    handles(request: Request): boolean {
      return new URL(request.url).pathname.startsWith(`${PRODUCTION_WORKFLOW_STUDIO_PREFIX}/`);
    },

    async fetch(request: Request): Promise<Response> {
      if (!["GET", "POST", "PUT"].includes(request.method)) {
        return problem(405, "method_not_allowed", "Method Not Allowed");
      }
      const caller = await input.identity.resolve(request);
      if (Result.isFailure(caller)) {
        return problem(
          caller.error.status,
          caller.error.code,
          caller.error.status === 401 ? "Authentication required" : "Forbidden",
        );
      }
      if (String(caller.value.organizationId) !== String(input.organizationId)) {
        return problem(403, "organization_mismatch", "Forbidden");
      }
      const permission = request.method === "GET" ? "viewer" : "editor";
      const allowed = await input.access.check({ caller: caller.value, permission });
      if (Result.isFailure(allowed)) {
        return problem(503, "workflow_studio_authz_unavailable", "Authorization unavailable");
      }
      if (!allowed.value) {
        return problem(403, "workflow_studio_forbidden", "Forbidden");
      }
      const response = await handleWorkflowStudio(request, {
        prefix: PRODUCTION_WORKFLOW_STUDIO_PREFIX,
        env: input.env,
        platform: input.platform,
        organizationId: caller.value.organizationId,
        actor: caller.value.principal,
        capabilityPolicy: input.capabilityPolicy,
        llmModel: input.llmModel,
      });
      if (!response) return problem(404, "not_found", "Not Found");
      // Repository/provider details belong in telemetry, never in the public response.
      if (response.status >= 500) {
        return problem(503, "workflow_studio_unavailable", "Workflow Studio unavailable");
      }
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    },
  };
}
