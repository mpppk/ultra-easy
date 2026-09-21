import { Result } from "@praha/byethrow";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

import type { OrganizationId, UserId } from "@app/approval-core";
import {
  HttpTrustedContextError,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";

export type Auth0IdentityConfig = {
  domain: string;
  audience: string;
  organizationId: OrganizationId;
};

type KeyResolver = JWTVerifyGetKey;

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

/**
 * Auth0 JWT (user login / M2M) を検証するPublicHttpIdentityProvider。
 * `sub` をUserIdへ写像し、URLのorganizationIdが設定組織と一致する場合のみ通す
 * （stagingは単一組織前提。複数組織はAUTH0 org mapping拡張時に追加する）。
 */
export class Auth0IdentityProvider implements PublicHttpIdentityProvider {
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
  ): Result.ResultAsync<{ userId: UserId }, HttpTrustedContextError> {
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
      });
      payload = verified.payload;
    } catch {
      return contextError(401, "invalid_bearer_token", "Bearer tokenの検証に失敗しました");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return contextError(401, "bearer_token_missing_sub", "tokenにsubがありません");
    }
    return Result.succeed({ userId: `user:${payload.sub}` as UserId });
  }

  async resolveSubject(input: {
    request: Request;
    organizationId: OrganizationId;
  }): Result.ResultAsync<string, HttpTrustedContextError> {
    const verified = await this.verify(input.request, input.organizationId);
    if (Result.isFailure(verified)) return verified;
    return Result.succeed(String(verified.value.userId));
  }

  async resolveUser(input: {
    request: Request;
    organizationId: OrganizationId;
  }): Result.ResultAsync<UserId, HttpTrustedContextError> {
    const verified = await this.verify(input.request, input.organizationId);
    if (Result.isFailure(verified)) return verified;
    return Result.succeed(verified.value.userId);
  }
}
