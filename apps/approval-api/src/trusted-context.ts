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
    actionType?: string;
    resourceType?: string;
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
    const authenticated = await this.identity.authenticateWithClient({
      request: input.request,
      organizationId: input.organizationId,
      operation: "action_request.submit",
      ...(input.actionType ? { actionType: input.actionType } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    });
    if (Result.isFailure(authenticated)) return authenticated;
    const { principal } = authenticated.value;
    return Result.succeed({
      actor: principal,
      authority: { principal },
      origin: {
        type: "api",
        clientId: authenticated.value.clientId,
        ...(principal.type === "user" ? { caller: principal } : {}),
      },
      organization: { id: input.organizationId },
      now: new Date().toISOString(),
    });
  }
}
