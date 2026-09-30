import { Result } from "@praha/byethrow";

import type {
  AuthorizationAdminAccessChecker,
  AuthorizationAdminCallerResolver,
} from "@app/approval-application";
import { decodeUriComponent, type OrganizationId } from "@app/approval-core";
import type { CapabilityPolicy } from "@app/workflow-application";
import { handleWorkflowStudio, type WorkflowPlatform } from "@app/workflow-platform";

import { APPLICATION_CATALOGS } from "./catalog/knowledge.ts";
import {
  catalogOwnsWorkflowArtifact,
  reservedActionTypeOwner,
  type ApplicationCatalog,
} from "./catalog/manifest.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await request
    .clone()
    .json()
    .catch(() => null);
  return isRecord(parsed) ? parsed : {};
}

/**
 * Application Catalog（#198）が所有するaction type / Workflow Definition / Programへの
 * Studioからの書き込みを拒否する。これらはreview済みcatalog migrationだけが登録し、
 * Studioのeditorが別versionを足して最新versionとして差し替えることはできない。
 */
async function catalogOwnedWrite(
  request: Request,
  catalogs: readonly ApplicationCatalog[],
): Promise<string | null> {
  if (request.method === "GET") return null;
  const path = new URL(request.url).pathname.slice(PRODUCTION_WORKFLOW_STUDIO_PREFIX.length + 1);
  // Studio handler decodes the path the same way (an undecodable path is its 400).
  const decoded = decodeUriComponent(path);
  const [resource, id, sub] = (Result.isSuccess(decoded) ? decoded.value : path)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (resource === "definitions" && id !== undefined) {
    if (catalogOwnsWorkflowArtifact(catalogs, { workflowDefinitionId: id })) {
      return `Workflow Definition ${id} is registered by an Application Catalog`;
    }
    if (request.method === "POST" && sub === "publish") {
      const actionType = (await jsonBody(request))["actionType"];
      const owner =
        typeof actionType === "string" ? reservedActionTypeOwner(catalogs, actionType) : null;
      if (owner) return `Action type ${String(actionType)} is owned by the ${owner} application`;
    }
  }
  if (resource === "programs" && id === "publish") {
    const draft = (await jsonBody(request))["draft"];
    const programId = isRecord(draft) ? draft["programId"] : undefined;
    if (typeof programId === "string" && catalogOwnsWorkflowArtifact(catalogs, { programId })) {
      return `Program ${programId} is registered by an Application Catalog`;
    }
  }
  return null;
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
  catalogs?: readonly ApplicationCatalog[];
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
      const reserved = await catalogOwnedWrite(request, input.catalogs ?? APPLICATION_CATALOGS);
      if (reserved) return problem(409, "catalog_owned", reserved);
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
