import { Result } from "@praha/byethrow";

import type {
  ActionAuthority,
  ActionOrigin,
  ActionType,
  ClientId,
  OrganizationId,
  PrincipalRef,
} from "@app/approval-core";

/**
 * Tool Exposureの入力。
 *
 * `tools/list` 時点ではresource / argumentsが存在しないため、ActionTypeと
 * trusted identity（actor / authority / organization / client）だけで判定する。
 * Exposure allowは実行許可ではない。`tools/call` では必ず別途Full Action Authorizationを行う。
 */
export type McpToolExposureRequest = {
  organizationId: OrganizationId;
  actor: PrincipalRef;
  authority: ActionAuthority;
  origin: ActionOrigin;
  actionType: ActionType;
  toolName: string;
};

export type McpToolExposureDecision = { type: "allow" } | { type: "deny"; code: string };

export class McpExposureProviderError extends Error {
  readonly name = "McpExposureProviderError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface McpToolExposureAuthorizer {
  check(
    input: McpToolExposureRequest,
  ): Result.ResultAsync<McpToolExposureDecision, McpExposureProviderError>;
}

function samePrincipal(left: PrincipalRef, right: PrincipalRef): boolean {
  return left.type === right.type && String(left.id) === String(right.id);
}

/**
 * 委任のscopeがActionTypeを許可していない場合はproviderへ問い合わせる前にhideする。
 * resource軸のscopeはtools/list時点では判定できないため、Full Authorizationに委ねる。
 */
export function delegationScopeAllowsActionType(
  authority: ActionAuthority,
  actionType: ActionType,
): boolean {
  for (const hop of authority.delegation?.chain ?? []) {
    const allowed = hop.scope?.actionTypes;
    if (allowed !== undefined && !allowed.some((value) => String(value) === String(actionType))) {
      return false;
    }
  }
  return true;
}

/** Gateway共通のExposure判定。provider errorはfail-closed（呼び出し側でerrorとして扱う）。 */
export async function checkMcpToolExposure(
  authorizer: McpToolExposureAuthorizer,
  input: McpToolExposureRequest,
): Result.ResultAsync<McpToolExposureDecision, McpExposureProviderError> {
  if (!delegationScopeAllowsActionType(input.authority, input.actionType)) {
    return Result.succeed({ type: "deny", code: "delegation_scope_excludes_action_type" });
  }
  const decided = await Result.fn({
    try: async () => authorizer.check(input),
    catch: (error) =>
      new McpExposureProviderError(
        "exposure_provider_threw",
        true,
        error instanceof Error ? error.message : String(error),
      ),
  })();
  if (Result.isFailure(decided)) return decided;
  return decided.value;
}

/**
 * 設定値による静的Exposure policy。いずれかのruleに全条件一致したらallow、それ以外はdeny。
 * ruleで省略した軸は制約しない。
 */
export type McpToolExposureRule = {
  organizationIds?: OrganizationId[];
  actionTypes?: ActionType[];
  authorityPrincipals?: PrincipalRef[];
  actors?: PrincipalRef[];
  clientIds?: ClientId[];
};

export class StaticMcpToolExposurePolicy implements McpToolExposureAuthorizer {
  constructor(private readonly rules: readonly McpToolExposureRule[]) {}

  check(input: McpToolExposureRequest) {
    const matched = this.rules.some(
      (rule) =>
        (rule.organizationIds === undefined ||
          rule.organizationIds.some((id) => String(id) === String(input.organizationId))) &&
        (rule.actionTypes === undefined ||
          rule.actionTypes.some((type) => String(type) === String(input.actionType))) &&
        (rule.authorityPrincipals === undefined ||
          rule.authorityPrincipals.some((principal) =>
            samePrincipal(principal, input.authority.principal),
          )) &&
        (rule.actors === undefined ||
          rule.actors.some((principal) => samePrincipal(principal, input.actor))) &&
        (rule.clientIds === undefined ||
          (input.origin.clientId !== undefined &&
            rule.clientIds.some((id) => String(id) === String(input.origin.clientId)))),
    );
    return Promise.resolve(
      Result.succeed<McpToolExposureDecision>(
        matched ? { type: "allow" } : { type: "deny", code: "exposure_policy_no_match" },
      ),
    );
  }
}

/** 全authorizerがallowの場合だけallow。最初のdeny / provider errorで打ち切る。 */
export class AllOfMcpToolExposureAuthorizer implements McpToolExposureAuthorizer {
  constructor(private readonly authorizers: readonly McpToolExposureAuthorizer[]) {}

  async check(
    input: McpToolExposureRequest,
  ): Result.ResultAsync<McpToolExposureDecision, McpExposureProviderError> {
    if (this.authorizers.length === 0) {
      return Result.succeed({ type: "deny", code: "exposure_policy_empty" });
    }
    for (const authorizer of this.authorizers) {
      const decided = await authorizer.check(input);
      if (Result.isFailure(decided)) return decided;
      if (decided.value.type === "deny") return decided;
    }
    return Result.succeed({ type: "allow" });
  }
}
