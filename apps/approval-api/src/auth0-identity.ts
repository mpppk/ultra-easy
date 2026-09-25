import { Result } from "@praha/byethrow";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
import { parseBrand } from "@app/approval-core";

import type { OrganizationId, PrincipalRef } from "@app/approval-core";
import {
  HttpTrustedContextError,
  type AuthorizationAdminCaller,
  type AuthorizationAdminCallerResolver,
  type PublicApiOperation,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";

/**
 * 組織所属の検証方法。tokenのclaim（Auth0 Organizationsの`org_id`等）で検証するか、
 * Auth0 tenant全体を単一organizationとして信頼するかを明示的に選ぶ。どちらも無ければ全て拒否する。
 */
export type Auth0OrganizationMembership =
  | { type: "claim"; claim: string; value: string }
  /**
   * tenantのuser / clientを全てorganizationのmemberとして扱う。public signupを無効にした
   * 単一組織tenant（staging）でだけ使う。
   */
  | { type: "tenant" };

export type Auth0IdentityConfig = {
  domain: string;
  audience: string;
  organizationId: OrganizationId;
  membership?: Auth0OrganizationMembership;
};

/** 操作ごとに必要なAPI scope（`scope` claimまたはRBACの`permissions` claim）。 */
export const PUBLIC_API_OPERATION_SCOPES: Record<PublicApiOperation, string> = {
  "action_request.read": "read:action-requests",
  "action_request.submit": "write:action-requests",
  "approval_decision.submit": "write:action-requests",
};

/** user loginで発行されるtokenの`gty`。省略（authorization code等）もuser tokenとして扱う。 */
const USER_GRANT_TYPES = new Set(["password", "refresh_token", "authorization_code"]);
const CLIENT_CREDENTIALS_GRANT_TYPE = "client-credentials";

type KeyResolver = JWTVerifyGetKey;

type VerifiedToken = { principal: PrincipalRef; payload: JWTPayload; scopes: ReadonlySet<string> };

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

function contextError(
  status: 401 | 403,
  code: string,
  message: string,
): Result.Result<never, HttpTrustedContextError> {
  return Result.fail(new HttpTrustedContextError(status, code, message));
}

function tokenScopes(payload: JWTPayload): Set<string> {
  const scopes = new Set<string>();
  if (typeof payload.scope === "string") {
    for (const scope of payload.scope.split(" ")) if (scope.length > 0) scopes.add(scope);
  }
  if (Array.isArray(payload.permissions)) {
    for (const permission of payload.permissions) {
      if (typeof permission === "string") scopes.add(permission);
    }
  }
  return scopes;
}

/**
 * tokenの種別からprincipalを決める。client credentials（M2M）はagent、user loginはuser。
 * 種別が判別できないtokenは拒否する（M2Mをuser principalへ潰さない）。
 */
function principalFromPayload(
  payload: JWTPayload & { sub: string },
): Result.Result<PrincipalRef, HttpTrustedContextError> {
  const grantType = payload.gty;
  const machineSubject = payload.sub.endsWith("@clients");
  if (grantType === CLIENT_CREDENTIALS_GRANT_TYPE || machineSubject) {
    const clientId =
      typeof payload.azp === "string" && payload.azp.length > 0
        ? payload.azp
        : payload.sub.slice(0, -"@clients".length);
    if (grantType !== CLIENT_CREDENTIALS_GRANT_TYPE || !machineSubject || clientId.length === 0) {
      return contextError(401, "unsupported_token_type", "client tokenの種別が一致しません");
    }
    const agentId = parseBrand("AgentId", `agent:${clientId}`);
    return Result.isFailure(agentId)
      ? contextError(401, "unsupported_token_type", "client IDが不正です")
      : Result.succeed({ type: "agent", id: agentId.value });
  }
  if (
    grantType !== undefined &&
    (typeof grantType !== "string" || !USER_GRANT_TYPES.has(grantType))
  ) {
    return contextError(401, "unsupported_token_type", "未対応のtoken種別です");
  }
  const userId = parseBrand("UserId", `user:${payload.sub}`);
  return Result.isFailure(userId)
    ? contextError(401, "bearer_token_missing_sub", "tokenのsubが不正です")
    : Result.succeed({ type: "user", id: userId.value });
}

/**
 * Auth0 JWT (user login / M2M) を検証するPublicHttpIdentityProvider。
 * iss / aud / alg に加えて、組織所属（membership）・操作ごとのscope・token種別を検証し、
 * user loginはuser principal、client credentialsはagent principalへ写像する
 * （stagingは単一組織前提。複数組織はAUTH0 org mapping拡張時に追加する）。
 */
export class Auth0IdentityProvider
  implements PublicHttpIdentityProvider, AuthorizationAdminCallerResolver
{
  private readonly resolveKey: KeyResolver;
  private readonly issuer: string;

  constructor(
    private readonly config: Auth0IdentityConfig,
    resolveKey?: KeyResolver,
  ) {
    this.issuer = `https://${config.domain}/`;
    this.resolveKey =
      resolveKey ?? createRemoteJWKSet(new URL(`https://${config.domain}/.well-known/jwks.json`));
  }

  private async verify(
    request: Request,
    organizationId: OrganizationId,
  ): Result.ResultAsync<VerifiedToken, HttpTrustedContextError> {
    if (String(organizationId) !== String(this.config.organizationId)) {
      return contextError(
        403,
        "organization_mismatch",
        "このdeploymentが担当するorganizationではありません",
      );
    }
    const token = bearerToken(request);
    if (!token) {
      return contextError(401, "bearer_token_missing", "Bearer tokenが必要です");
    }
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.resolveKey, {
        issuer: this.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
      });
      payload = verified.payload;
    } catch {
      return contextError(401, "invalid_bearer_token", "Bearer tokenの検証に失敗しました");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return contextError(401, "bearer_token_missing_sub", "tokenにsubがありません");
    }

    const membership = this.config.membership;
    if (!membership) {
      return contextError(
        403,
        "organization_membership_unverified",
        "organization所属を検証する設定がありません",
      );
    }
    if (membership.type === "claim" && payload[membership.claim] !== membership.value) {
      return contextError(
        403,
        "organization_membership_required",
        "tokenのorganizationがこのdeploymentと一致しません",
      );
    }

    const principal = principalFromPayload({ ...payload, sub: payload.sub });
    if (Result.isFailure(principal)) return principal;
    return Result.succeed({ principal: principal.value, payload, scopes: tokenScopes(payload) });
  }

  /**
   * Admin console caller. The organization is this deployment's configured
   * organization (never taken from the request). Machine (client-credentials)
   * tokens are rejected: console administration requires a human user.
   */
  async resolve(
    request: Request,
  ): Result.ResultAsync<AuthorizationAdminCaller, HttpTrustedContextError> {
    const verified = await this.verify(request, this.config.organizationId);
    if (Result.isFailure(verified)) return verified;
    const { principal } = verified.value;
    if (principal.type !== "user") {
      return contextError(
        403,
        "machine_principal_not_allowed",
        "管理Consoleはuser principalのみ利用できます",
      );
    }
    return Result.succeed({ organizationId: this.config.organizationId, principal });
  }

  async authenticate(input: {
    request: Request;
    organizationId: OrganizationId;
    operation: PublicApiOperation;
  }): Result.ResultAsync<PrincipalRef, HttpTrustedContextError> {
    const verified = await this.verify(input.request, input.organizationId);
    if (Result.isFailure(verified)) return verified;
    const required = PUBLIC_API_OPERATION_SCOPES[input.operation];
    if (!verified.value.scopes.has(required)) {
      return contextError(403, "insufficient_scope", `この操作には${required} scopeが必要です`);
    }
    return Result.succeed(verified.value.principal);
  }
}

/** wrangler varsから組織所属の検証方法を読む。未設定なら検証不能としてfail closedにする。 */
export function readAuth0OrganizationMembership(env: {
  AUTH0_ORGANIZATION_CLAIM?: string;
  AUTH0_ORGANIZATION_CLAIM_VALUE?: string;
  AUTH0_TENANT_IS_ORGANIZATION?: string;
}): Auth0OrganizationMembership | undefined {
  const value = env.AUTH0_ORGANIZATION_CLAIM_VALUE?.trim();
  if (value) {
    return { type: "claim", claim: env.AUTH0_ORGANIZATION_CLAIM?.trim() || "org_id", value };
  }
  return env.AUTH0_TENANT_IS_ORGANIZATION === "true" ? { type: "tenant" } : undefined;
}
