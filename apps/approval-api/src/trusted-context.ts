import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import {
  HttpTrustedContextError,
  type HttpTrustedContextProvider,
  type TrustedActionRequestContext,
} from "@app/approval-application";

import type { Auth0IdentityProvider } from "./auth0-identity.ts";

/**
 * Staging用のtrusted context。検証済みJWTのprincipal（user login → user、
 * client credentials → agent）をactor/authorityの両方に使う
 * （委任なしのdirect実行前提。DelegationはM8スコープ外）。
 * M2M clientの背後に居るuserは不明なため、origin.callerは設定しない。
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
    const authenticated = await this.identity.authenticate({
      request: input.request,
      organizationId: input.organizationId,
      operation: "action_request.submit",
    });
    if (Result.isFailure(authenticated)) return authenticated;
    const principal = authenticated.value;
    return Result.succeed({
      actor: principal,
      authority: { principal },
      origin: { type: "api" },
      organization: { id: input.organizationId },
      now: new Date().toISOString(),
    });
  }
}
