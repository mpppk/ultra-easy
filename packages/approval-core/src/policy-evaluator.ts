import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { ApprovalPolicyBinding, ApprovalPolicyDefinition } from "./domain/policy.ts";
import type { ApprovalPolicyBindingId, ApprovalPolicyKey } from "./domain/brand.ts";
import type { FlowConstraints, FlowDefinition } from "./domain/flow.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import type { ConditionEvaluationError } from "./condition-evaluator.ts";
import { evaluateCondition } from "./condition-evaluator.ts";

export type PolicyEvaluation =
  | {
      type: "matched";
      policyKey: ApprovalPolicyKey;
      ruleKey: ApprovalPolicyDefinition["rules"][number]["key"];
      flow: FlowDefinition;
    }
  | { type: "not_matched"; policyKey: ApprovalPolicyKey };

const PolicyEvaluationErrorBase = ErrorFactory({
  name: "PolicyEvaluationError",
  message: "PolicyのCondition評価に失敗しました。",
  fields: ErrorFactory.fields<{
    code: "policy_condition_evaluation_failed";
    policyKey: ApprovalPolicyKey;
  }>(),
});

export class PolicyEvaluationError extends PolicyEvaluationErrorBase {
  declare readonly cause: ConditionEvaluationError;

  constructor(options: { policyKey: ApprovalPolicyKey; cause: ConditionEvaluationError }) {
    super({
      code: "policy_condition_evaluation_failed",
      policyKey: options.policyKey,
      cause: options.cause,
    });
  }
}

export type PolicyEvaluationResult = Result.Result<PolicyEvaluation, PolicyEvaluationError>;

const PolicyBindingResolutionErrorBase = ErrorFactory({
  name: "PolicyBindingResolutionError",
  message: "Policy BindingのCondition評価に失敗しました。",
  fields: ErrorFactory.fields<{
    code: "binding_condition_evaluation_failed";
    bindingId: ApprovalPolicyBindingId;
  }>(),
});

export class PolicyBindingResolutionError extends PolicyBindingResolutionErrorBase {
  declare readonly cause: ConditionEvaluationError;

  constructor(options: { bindingId: ApprovalPolicyBindingId; cause: ConditionEvaluationError }) {
    super({
      code: "binding_condition_evaluation_failed",
      bindingId: options.bindingId,
      cause: options.cause,
    });
  }
}

export type PolicyBindingResolutionResult = Result.Result<
  ApprovalPolicyBinding[],
  PolicyBindingResolutionError
>;

export type EvaluatedPolicyBinding = {
  binding: ApprovalPolicyBinding;
  evaluation: PolicyEvaluation;
};

export type ApprovalPlanEvaluation = {
  flow: FlowDefinition;
  applicableBindings: ApprovalPolicyBinding[];
  policyEvaluations: EvaluatedPolicyBinding[];
};

const ApprovalPlanBindingEvaluationErrorBase = ErrorFactory({
  name: "ApprovalPlanBindingEvaluationError",
  message: "Approval PlanのBinding評価に失敗しました。",
  fields: ErrorFactory.fields<{
    type: "binding_evaluation_failed";
    bindingId: ApprovalPolicyBindingId;
  }>(),
});

export class ApprovalPlanBindingEvaluationError extends ApprovalPlanBindingEvaluationErrorBase {
  declare readonly cause: PolicyBindingResolutionError;

  constructor(options: { bindingId: ApprovalPolicyBindingId; cause: PolicyBindingResolutionError }) {
    super({
      type: "binding_evaluation_failed",
      bindingId: options.bindingId,
      cause: options.cause,
    });
  }
}

export class ApprovalPlanPolicyNotFoundError extends ErrorFactory({
  name: "ApprovalPlanPolicyNotFoundError",
  message: ({ policyKey }) => `Policyが見つかりません: ${String(policyKey)}`,
  fields: ErrorFactory.fields<{
    type: "policy_not_found";
    bindingId: ApprovalPolicyBindingId;
    policyKey: ApprovalPolicyKey;
  }>(),
}) {}

const ApprovalPlanPolicyEvaluationErrorBase = ErrorFactory({
  name: "ApprovalPlanPolicyEvaluationError",
  message: "Approval PlanのPolicy評価に失敗しました。",
  fields: ErrorFactory.fields<{
    type: "policy_evaluation_failed";
    bindingId: ApprovalPolicyBindingId;
    policyKey: ApprovalPolicyKey;
  }>(),
});

export class ApprovalPlanPolicyEvaluationError extends ApprovalPlanPolicyEvaluationErrorBase {
  declare readonly cause: PolicyEvaluationError;

  constructor(options: {
    bindingId: ApprovalPolicyBindingId;
    policyKey: ApprovalPolicyKey;
    cause: PolicyEvaluationError;
  }) {
    super({
      type: "policy_evaluation_failed",
      bindingId: options.bindingId,
      policyKey: options.policyKey,
      cause: options.cause,
    });
  }
}

export type ApprovalPlanEvaluationError =
  | ApprovalPlanBindingEvaluationError
  | ApprovalPlanPolicyNotFoundError
  | ApprovalPlanPolicyEvaluationError;

export type ApprovalPlanEvaluationResult = Result.Result<
  ApprovalPlanEvaluation,
  ApprovalPlanEvaluationError
>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareBindings(left: ApprovalPolicyBinding, right: ApprovalPolicyBinding): number {
  const order = (left.compositionOrder ?? 1000) - (right.compositionOrder ?? 1000);
  if (order !== 0) return order;
  return compareStrings(String(left.id), String(right.id));
}

function matchesActionType(pattern: string, actual: string): boolean {
  if (!pattern.endsWith("*")) return pattern === actual;
  return actual.startsWith(pattern.slice(0, -1));
}

/** enabled / tenant / selector条件をpureに評価して適用Bindingだけを返す。 */
export function resolvePolicyBindings(
  bindings: readonly ApprovalPolicyBinding[],
  context: PolicyEvaluationContext,
): PolicyBindingResolutionResult {
  const applicable: ApprovalPolicyBinding[] = [];

  for (const binding of bindings) {
    if (!binding.enabled) continue;
    if (String(binding.organizationId) !== String(context.organization.id)) continue;
    if (
      !binding.selector.actionTypes.some((pattern) =>
        matchesActionType(String(pattern), String(context.action.type)),
      )
    ) {
      continue;
    }
    if (
      binding.selector.resourceTypes &&
      !binding.selector.resourceTypes.some(
        (resourceType) => String(resourceType) === String(context.action.resource.type),
      )
    ) {
      continue;
    }

    if (binding.selector.when) {
      const result = evaluateCondition(binding.selector.when, context);
      if (Result.isFailure(result)) {
        return Result.fail(
          new PolicyBindingResolutionError({ bindingId: binding.id, cause: result.error }),
        );
      }
      if (result.value.type === "not_matched") continue;
    }

    applicable.push(binding);
  }

  return Result.succeed(applicable.sort(compareBindings));
}

/** 単一Policyを配列順で評価し、最初に一致したRuleだけを採用する。 */
export function evaluatePolicy(
  policy: ApprovalPolicyDefinition,
  context: PolicyEvaluationContext,
): PolicyEvaluationResult {
  for (const rule of policy.rules) {
    if (rule.when.type === "always") {
      return Result.succeed({
        type: "matched",
        policyKey: policy.key,
        ruleKey: rule.key,
        flow: rule.flow,
      });
    }

    const result = evaluateCondition(rule.when, context);
    if (Result.isFailure(result)) {
      return Result.fail(new PolicyEvaluationError({ policyKey: policy.key, cause: result.error }));
    }
    if (result.value.type === "matched") {
      return Result.succeed({
        type: "matched",
        policyKey: policy.key,
        ruleKey: rule.key,
        flow: rule.flow,
      });
    }
  }

  return Result.succeed({ type: "not_matched", policyKey: policy.key });
}

/**
 * Binding順を決定的に並べ、non-none Flowだけをv1規約どおりserial合成する。
 * not_matchedと明示的noneは監査上区別したまま、最終FlowにはどちらもStepを追加しない。
 */
export function compileApprovalFlow(
  evaluations: readonly EvaluatedPolicyBinding[],
  defaultFlowConstraints?: FlowConstraints,
): FlowDefinition {
  const flows = [...evaluations]
    .sort((left, right) => compareBindings(left.binding, right.binding))
    .flatMap((item) =>
      item.evaluation.type === "matched" && item.evaluation.flow.type !== "none"
        ? [item.evaluation.flow]
        : [],
    );

  if (flows.length === 0) return { type: "none" };
  if (flows.length === 1) return flows[0] as FlowDefinition;

  return {
    type: "serial",
    children: flows,
    ...(defaultFlowConstraints ? { constraints: defaultFlowConstraints } : {}),
  };
}

/** Binding選択→Policy評価→Flow合成を外部I/Oなしで一括実行する。 */
export function evaluateApprovalPlan(input: {
  context: PolicyEvaluationContext;
  bindings: readonly ApprovalPolicyBinding[];
  policies: readonly ApprovalPolicyDefinition[];
}): ApprovalPlanEvaluationResult {
  const resolved = resolvePolicyBindings(input.bindings, input.context);
  if (Result.isFailure(resolved)) {
    return Result.fail(
      new ApprovalPlanBindingEvaluationError({
        bindingId: resolved.error.bindingId,
        cause: resolved.error,
      }),
    );
  }

  const policyEvaluations: EvaluatedPolicyBinding[] = [];
  for (const binding of resolved.value) {
    const policy = input.policies.find(
      (candidate) => String(candidate.key) === String(binding.policyKey),
    );
    if (!policy) {
      return Result.fail(
        new ApprovalPlanPolicyNotFoundError({
          type: "policy_not_found",
          bindingId: binding.id,
          policyKey: binding.policyKey,
        }),
      );
    }

    const evaluation = evaluatePolicy(policy, input.context);
    if (Result.isFailure(evaluation)) {
      return Result.fail(
        new ApprovalPlanPolicyEvaluationError({
          bindingId: binding.id,
          policyKey: policy.key,
          cause: evaluation.error,
        }),
      );
    }
    policyEvaluations.push({ binding, evaluation: evaluation.value });
  }

  const flow = compileApprovalFlow(
    policyEvaluations,
    input.context.organization.defaultFlowConstraints,
  );

  return Result.succeed({
    flow,
    applicableBindings: resolved.value,
    policyEvaluations,
  });
}
