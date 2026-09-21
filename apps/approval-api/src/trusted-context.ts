import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import {
  HttpTrustedContextError,
  type HttpTrustedContextProvider,
  type TrustedActionRequestContext,
} from "@app/approval-application";

import type { Auth0IdentityProvider } from "./auth0-identity.ts";

/**
 * Staging用のtrusted context。検証済みJWTのsubをactor/authorityの両方に使う
 * （委任なしのdirect実行前提。DelegationはM8スコープ外）。
 */
export class StagingTrustedContextProvider implements HttpTrustedContextProvider {
  constructor(private readonly identity: Auth0IdentityProvider) {}

  async resolve(input: {
    request: Request;
    organizationId: OrganizationId;
    delegationGrantId?: string;
    clientReference?: string;
  }): Result.ResultAsync<TrustedActionRequestContext, HttpTrustedContextError> {
    if (input.delegationGrantId) {
      return Result.fail(
        new HttpTrustedContextError(
          403,
          "delegation_not_supported",
          "staging APIは委任付きActionRequestを受け付けません",
        ),
      );
    }
    const user = await this.identity.resolveUser({
      request: input.request,
      organizationId: input.organizationId,
    });
    if (Result.isFailure(user)) return user;
    const principal = { type: "user", id: user.value } as const;
    return Result.succeed({
      actor: principal,
      authority: { principal },
      origin: { type: "api" },
      organization: { id: input.organizationId },
      now: new Date().toISOString(),
    });
  }
}
