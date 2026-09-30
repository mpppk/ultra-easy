import { Result } from "@praha/byethrow";

import {
  parseBrand,
  validateApplicationApprovalPolicyUpdateInput,
  type ActionRequestId,
  type ApplicationApprovalPolicy,
  type ApplicationApprovalPolicyRecord,
  type ApplicationApprovalPolicyScope,
  type ApplicationApprovalScheme,
  type OrganizationId,
  type UserId,
} from "@app/approval-core";

import type { ActionRequestView } from "./action-request-service.ts";
import { matchHttpRoute } from "./http-access-log.ts";
import { authenticatePublicApi, type PublicHttpIdentityProvider } from "./public-http.ts";
import type { PublicApiRepositoryError } from "./read-command.ts";

export const PUBLIC_APPLICATION_APPROVAL_POLICY_ROUTES = [
  "/v1/organizations/{organizationId}/application-policies/{scopeType}/{scopeId}",
] as const;

export interface ApplicationApprovalPolicyReadRepository {
  current(
    scope: ApplicationApprovalPolicyScope,
  ): Result.ResultAsync<
    ApplicationApprovalPolicyRecord | null,
    { code: string; retriable: boolean }
  >;
  recentProposalIds(input: {
    organizationId: OrganizationId;
    scopeType: string;
    scopeId: string;
    limit: number;
  }): Result.ResultAsync<string[], { code: string; retriable: boolean }>;
}

export interface ApplicationScopeAccessChecker {
  /** scopeのmember（例: `knowledge_space#can_view`）か。 */
  canView(input: {
    organizationId: OrganizationId;
    scopeType: string;
    scopeId: string;
    userId: UserId;
  }): Result.ResultAsync<boolean, { code: string; retriable: boolean }>;
}

/** 反映待ちとして返すproposalの状態（終端していない）。 */
const IN_PROGRESS = new Set(["evaluating", "pending_approval", "approved", "executing"]);
const PROPOSAL_SCAN_LIMIT = 10;

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    {
      status,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    },
  );
}

export type ApplicationApprovalPolicyView = {
  scopeType: string;
  scopeId: string;
  /** 0 = 固有ruleが無く既定ruleが適用されている。 */
  version: number;
  policy: ApplicationApprovalPolicy;
  /** 現在のversionを基にした未反映の変更（meta-approval待ち等）。 */
  pendingChange: {
    actionRequestId: string;
    status: string;
    requestedBy: string;
    policy: ApplicationApprovalPolicy;
  } | null;
};

/**
 * Application-scoped approval ruleの読み取り（#199）。変更は通常のActionRequest
 * （`application.approval_policy.update`）で提出する。
 */
export function createPublicApplicationApprovalPolicyApi(input: {
  schemes: readonly ApplicationApprovalScheme[];
  repository: ApplicationApprovalPolicyReadRepository;
  actionRequests: {
    getActionRequest(input: {
      organizationId: OrganizationId;
      actionRequestId: ActionRequestId;
    }): Result.ResultAsync<ActionRequestView | null, PublicApiRepositoryError>;
  };
  identityProvider: PublicHttpIdentityProvider;
  accessChecker: ApplicationScopeAccessChecker;
  /** scopeのruleを読める登録済みapplication agent（`agent:<client id>`）。 */
  applicationAgentId?: string;
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  return {
    handles(request) {
      return (
        request.method === "GET" &&
        matchHttpRoute(PUBLIC_APPLICATION_APPROVAL_POLICY_ROUTES, new URL(request.url).pathname) !==
          null
      );
    },
    async fetch(request) {
      const url = new URL(request.url);
      const matched = matchHttpRoute(PUBLIC_APPLICATION_APPROVAL_POLICY_ROUTES, url.pathname);
      if (!matched || request.method !== "GET") {
        return problem(404, "route_not_found", "Route not found");
      }
      const organization = parseBrand("OrganizationId", matched.parameters["organizationId"]);
      if (Result.isFailure(organization)) {
        return problem(400, "invalid_organization_id", "Organization IDが不正です");
      }
      const organizationId = organization.value;
      const scopeType = matched.parameters["scopeType"] ?? "";
      const scopeId = matched.parameters["scopeId"] ?? "";
      const scheme = input.schemes.find((candidate) => candidate.scopeResourceType === scopeType);
      if (!scheme) return problem(404, "application_policy_scope_not_found", "Scopeがありません");
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(scopeId)) {
        return problem(400, "invalid_scope_id", "Scope IDが不正です");
      }
      const principal = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: "application_policy.read",
        resourceType: scopeType,
      });
      if (principal instanceof Response) return principal;
      if (principal.type === "user") {
        const allowed = await input.accessChecker.canView({
          organizationId,
          scopeType,
          scopeId,
          userId: principal.id,
        });
        if (Result.isFailure(allowed)) {
          return problem(503, "scope_access_check_failed", "Scope権限を確認できません");
        }
        if (!allowed.value)
          return problem(403, "scope_member_required", "Scopeのmember権限が必要です");
      } else if (principal.type !== "agent" || String(principal.id) !== input.applicationAgentId) {
        return problem(403, "application_agent_required", "登録済みapplication agentが必要です");
      }

      const scope = { organizationId, application: scheme.application, scopeType, scopeId };
      const current = await input.repository.current(scope);
      if (Result.isFailure(current)) {
        return problem(
          current.error.retriable ? 503 : 500,
          current.error.code,
          "Ruleを取得できません",
        );
      }
      const version = current.value?.version ?? 0;
      const proposals = await input.repository.recentProposalIds({
        organizationId,
        scopeType,
        scopeId,
        limit: PROPOSAL_SCAN_LIMIT,
      });
      if (Result.isFailure(proposals)) {
        return problem(
          proposals.error.retriable ? 503 : 500,
          proposals.error.code,
          "変更提案を取得できません",
        );
      }
      let pendingChange: ApplicationApprovalPolicyView["pendingChange"] = null;
      for (const id of proposals.value) {
        const actionRequestId = parseBrand("ActionRequestId", id);
        if (Result.isFailure(actionRequestId)) continue;
        const view = await input.actionRequests.getActionRequest({
          organizationId,
          actionRequestId: actionRequestId.value,
        });
        if (Result.isFailure(view)) {
          return problem(
            view.error.retriable ? 503 : 500,
            view.error.code,
            "変更提案を取得できません",
          );
        }
        if (!view.value || !IN_PROGRESS.has(view.value.status)) continue;
        const proposed = validateApplicationApprovalPolicyUpdateInput(
          scheme,
          view.value.action.input,
        );
        // 現在のversionを基にしていない提案は、承認されても適用時にconflictになる。
        if (proposed.type !== "valid" || proposed.input.baseVersion !== version) continue;
        pendingChange = {
          actionRequestId: String(view.value.id),
          status: view.value.status,
          requestedBy: String(view.value.authorityPrincipal.id),
          policy: proposed.input.policy,
        };
        break;
      }
      const body: ApplicationApprovalPolicyView = {
        scopeType,
        scopeId,
        version,
        policy: current.value?.policy ?? scheme.defaultPolicy,
        pendingChange,
      };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    },
  };
}
