import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { ActionRequest } from "./domain/action.ts";
import type { DelegationGrantId } from "./domain/brand.ts";
import type { DelegationHop, DelegationScope, PrincipalRef } from "./domain/principal.ts";

export type AuthorizationConsistency = "minimize_latency" | "higher_consistency";

export type AuthorityMode = "direct" | "delegated";

export type AuthorizationEvidence = {
  evaluatedAt: string;
  provider?: string;
  contextChecksum?: string;
  authorizationModelId?: string;
  consistency: AuthorizationConsistency;
  authorityMode?: AuthorityMode;
  delegationGrantIds?: DelegationGrantId[];
};

export type AuthorizationDecision =
  | { type: "allow"; evidence: AuthorizationEvidence }
  | { type: "deny"; code: string; reason: string };

const AuthorizationProviderErrorBase = ErrorFactory({
  name: "AuthorizationProviderError",
  message: ({ provider, detail }) => `${provider}によるAuthorization判定に失敗しました: ${detail}`,
  fields: ErrorFactory.fields<{
    provider: string;
    code: string;
    retriable: boolean;
    detail: string;
  }>(),
});

export class AuthorizationProviderError extends AuthorizationProviderErrorBase {
  constructor(options: {
    provider: string;
    code: string;
    retriable: boolean;
    detail: string;
    cause?: Error;
  }) {
    super({
      provider: options.provider,
      code: options.code,
      retriable: options.retriable,
      detail: options.detail,
      ...(options.cause ? { cause: options.cause } : {}),
    });
  }
}

export interface ActionAuthorizer {
  check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<AuthorizationDecision, AuthorizationProviderError>;
}

export type EffectiveAuthorityValidation =
  | {
      type: "valid";
      mode: AuthorityMode;
      delegationGrantIds: DelegationGrantId[];
    }
  | {
      type: "deny";
      code:
        | "authority_actor_mismatch"
        | "delegation_chain_invalid"
        | "delegation_scope_denied"
        | "delegation_scope_invalid"
        | "delegation_not_active";
      reason: string;
    };

function samePrincipal(left: PrincipalRef, right: PrincipalRef): boolean {
  return left.type === right.type && String(left.id) === String(right.id);
}

function includesString(values: readonly string[] | undefined, value: string): boolean {
  return values === undefined || values.some((candidate) => String(candidate) === value);
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validateScope(
  scope: DelegationScope | undefined,
  request: ActionRequest,
  evaluatedAt: string,
): EffectiveAuthorityValidation | null {
  if (!scope) return null;

  if (!includesString(scope.actionTypes, String(request.action.type))) {
    return {
      type: "deny",
      code: "delegation_scope_denied",
      reason: `delegation scopeがAction typeを許可していません: ${String(request.action.type)}`,
    };
  }
  if (!includesString(scope.resourceTypes, String(request.action.resource.type))) {
    return {
      type: "deny",
      code: "delegation_scope_denied",
      reason: `delegation scopeがResource typeを許可していません: ${String(request.action.resource.type)}`,
    };
  }
  if (!includesString(scope.resourceIds, String(request.action.resource.id))) {
    return {
      type: "deny",
      code: "delegation_scope_denied",
      reason: `delegation scopeがResource IDを許可していません: ${String(request.action.resource.id)}`,
    };
  }

  const evaluatedTimestamp = parseTimestamp(evaluatedAt);
  if (evaluatedTimestamp === null) {
    return {
      type: "deny",
      code: "delegation_scope_invalid",
      reason: `Authorization評価時刻が不正です: ${evaluatedAt}`,
    };
  }

  if (scope.notBefore) {
    const notBefore = parseTimestamp(scope.notBefore);
    if (notBefore === null) {
      return {
        type: "deny",
        code: "delegation_scope_invalid",
        reason: `delegation scopeのnotBeforeが不正です: ${scope.notBefore}`,
      };
    }
    if (evaluatedTimestamp < notBefore) {
      return {
        type: "deny",
        code: "delegation_not_active",
        reason: "delegation scopeの有効開始前です",
      };
    }
  }

  if (scope.expiresAt) {
    const expiresAt = parseTimestamp(scope.expiresAt);
    if (expiresAt === null) {
      return {
        type: "deny",
        code: "delegation_scope_invalid",
        reason: `delegation scopeのexpiresAtが不正です: ${scope.expiresAt}`,
      };
    }
    if (evaluatedTimestamp >= expiresAt) {
      return {
        type: "deny",
        code: "delegation_not_active",
        reason: "delegation scopeの有効期限が切れています",
      };
    }
  }

  return null;
}

function validateDelegationContinuity(chain: readonly DelegationHop[]): boolean {
  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1];
    const current = chain[index];
    if (!previous || !current || !samePrincipal(previous.delegatee, current.delegator)) return false;
  }
  return true;
}

/**
 * Authority PrincipalからActorまでの委任chainと各scopeをpureに検証する。
 * 各hopのscopeをすべて満たす必要があるため、chainを延長しても実効権限は拡張されない。
 */
export function validateEffectiveAuthority(
  request: ActionRequest,
  evaluatedAt: string,
): EffectiveAuthorityValidation {
  const chain = request.authority.delegation?.chain ?? [];
  if (chain.length === 0) {
    if (!samePrincipal(request.actor, request.authority.principal)) {
      return {
        type: "deny",
        code: "authority_actor_mismatch",
        reason: "DelegationなしではActorとAuthority Principalが一致する必要があります",
      };
    }
    return { type: "valid", mode: "direct", delegationGrantIds: [] };
  }

  const first = chain[0];
  const last = chain[chain.length - 1];
  if (
    !first ||
    !last ||
    !samePrincipal(first.delegator, request.authority.principal) ||
    !samePrincipal(last.delegatee, request.actor) ||
    !validateDelegationContinuity(chain)
  ) {
    return {
      type: "deny",
      code: "delegation_chain_invalid",
      reason: "Delegation chainがAuthority PrincipalからActorまで連続していません",
    };
  }

  for (const hop of chain) {
    const scopeResult = validateScope(hop.scope, request, evaluatedAt);
    if (scopeResult) return scopeResult;
  }

  return {
    type: "valid",
    mode: "delegated",
    delegationGrantIds: chain.map((hop) => hop.grantId),
  };
}

export async function authorizeActionRequest(input: {
  authorizer: ActionAuthorizer;
  request: ActionRequest;
  evaluatedAt: string;
  consistency?: AuthorizationConsistency;
}): Result.ResultAsync<AuthorizationDecision, AuthorizationProviderError> {
  const effectiveAuthority = validateEffectiveAuthority(input.request, input.evaluatedAt);
  if (effectiveAuthority.type === "deny") return Result.succeed(effectiveAuthority);

  const consistency = input.consistency ?? "higher_consistency";
  const providerResult = await input.authorizer.check({
    request: input.request,
    evaluatedAt: input.evaluatedAt,
    consistency,
  });
  if (Result.isFailure(providerResult)) return providerResult;
  if (providerResult.value.type === "deny") return providerResult;

  return Result.succeed({
    type: "allow",
    evidence: {
      ...providerResult.value.evidence,
      evaluatedAt: input.evaluatedAt,
      consistency,
      authorityMode: effectiveAuthority.mode,
      delegationGrantIds: effectiveAuthority.delegationGrantIds,
    },
  });
}

/** ActionExecutor直前の再認可は常にhigher consistencyで実行する。 */
export function reauthorizeActionRequest(input: {
  authorizer: ActionAuthorizer;
  request: ActionRequest;
  evaluatedAt: string;
}): Result.ResultAsync<AuthorizationDecision, AuthorizationProviderError> {
  return authorizeActionRequest({ ...input, consistency: "higher_consistency" });
}
