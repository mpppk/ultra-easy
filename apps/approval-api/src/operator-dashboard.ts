import { Result } from "@praha/byethrow";

import type {
  AuthorizationAdminAccessChecker,
  AuthorizationAdminCallerResolver,
} from "@app/approval-application";
import type { OrganizationId } from "@app/approval-core";

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * Operator dashboard。authorization_admin viewer（運用者）のuserだけが、自分のorganizationの
 * snapshotを参照できる。organizationIdを指定する場合は認証済みcallerのorganizationと一致する
 * 必要がある（他orgは403）。内部エラーのmessageは応答に含めない。
 */
export async function handleOperatorDashboard<View extends object>(input: {
  request: Request;
  callerResolver: AuthorizationAdminCallerResolver;
  accessChecker: AuthorizationAdminAccessChecker;
  load(organizationId: OrganizationId): Result.ResultAsync<View, { code: string }>;
  onError?(code: string): void;
}): Promise<Response> {
  const caller = await input.callerResolver.resolve(input.request);
  if (Result.isFailure(caller)) {
    return problem(
      caller.error.status,
      caller.error.code,
      caller.error.status === 401 ? "Authentication required" : "Forbidden",
    );
  }
  const allowed = await input.accessChecker.check({ caller: caller.value, permission: "viewer" });
  if (Result.isFailure(allowed)) {
    input.onError?.(allowed.error.code);
    return problem(503, "operator_access_check_failed", "operator権限を確認できません");
  }
  if (!allowed.value) {
    return problem(403, "operator_access_denied", "operator dashboardを参照する権限がありません");
  }

  const requested = new URL(input.request.url).searchParams.get("organizationId")?.trim();
  if (requested !== undefined && requested !== String(caller.value.organizationId)) {
    return problem(403, "organization_mismatch", "他のorganizationは参照できません");
  }
  const loaded = await input.load(caller.value.organizationId);
  if (Result.isFailure(loaded)) {
    input.onError?.(loaded.error.code);
    return problem(503, "operator_dashboard_unavailable", "operator dashboardを取得できません");
  }
  return Response.json(loaded.value, { status: 200 });
}
