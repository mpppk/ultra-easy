import type { ApprovalPolicyBinding, ApprovalPolicyDefinition } from "./domain/policy.ts";
import type { ApprovalPolicyBindingId, ApprovalPolicyKey } from "./domain/brand.ts";
import type { FlowConstraints, FlowDefinition } from "./domain/flow.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import type { ConditionEvaluationError } from "./condition-evaluator.ts";
import { evaluateCondition } from "./condition-evaluator.ts";

export type PolicyEvaluationResult =
  | {
      type: "matched";
      policyKey: ApprovalPolicyKey;
      ruleKey: ApprovalPolicyDefinition["rules"][number]["key"];
      flow: FlowDefinition;
    }
  | { type: "not_matched"; policyKey: ApprovalPolicyKey }
  | { type: "error"; policyKey: ApprovalPolicyKey; error: ConditionEvaluationError };

export type PolicyBindingResolutionResult =
  | { type: "resolved"; bindings: ApprovalPolicyBinding[] }
  | {
      type: "error";
      bindingId: ApprovalPolicyBindingId;
      error: ConditionEvaluationError;
    };

export type EvaluatedPolicyBinding = {
  binding: ApprovalPolicyBinding;
  evaluation: PolicyEvaluationResult;
};

export type ApprovalFlowCompilationResult =
  | { type: "compiled"; flow: FlowDefinition }
  | {
      type: "error";
      bindingId: ApprovalPolicyBindingId;
      policyKey: ApprovalPolicyKey;
      error: ConditionEvaluationError;
    };

export type ApprovalPlanEvaluationResult =
  | {
      type: "compiled";
      flow: FlowDefinition;
      applicableBindings: ApprovalPolicyBinding[];
      policyEvaluations: EvaluatedPolicyBinding[];
    }
  | {
      type: "error";
      stage: "binding" | "policy" | "policy_resolution";
      bindingId?: ApprovalPolicyBindingId;
      policyKey?: ApprovalPolicyKey;
      error: ConditionEvaluationError | { code: "policy_not_found"; message: string };
    };

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
      if (result.type === "error") {
        return { type: "error", bindingId: binding.id, error: result };
      }
      if (result.type === "not_matched") continue;
    }

    applicable.push(binding);
  }

  return { type: "resolved", bindings: applicable.sort(compareBindings) };
}

/** 単一Policyを配列順で評価し、最初に一致したRuleだけを採用する。 */
export function evaluatePolicy(
  policy: ApprovalPolicyDefinition,
  context: PolicyEvaluationContext,
): PolicyEvaluationResult {
  for (const rule of policy.rules) {
    if (rule.when.type === "always") {
      return { type: "matched", policyKey: policy.key, ruleKey: rule.key, flow: rule.flow };
    }

    const result = evaluateCondition(rule.when, context);
    if (result.type === "error") {
      return { type: "error", policyKey: policy.key, error: result };
    }
    if (result.type === "matched") {
      return { type: "matched", policyKey: policy.key, ruleKey: rule.key, flow: rule.flow };
    }
  }

  return { type: "not_matched", policyKey: policy.key };
}

/**
 * Binding順を決定的に並べ、non-none Flowだけをv1規約どおりserial合成する。
 * not_matchedと明示的noneは監査上区別したまま、最終FlowにはどちらもStepを追加しない。
 */
export function compileApprovalFlow(
  evaluations: readonly EvaluatedPolicyBinding[],
  defaultFlowConstraints?: FlowConstraints,
): ApprovalFlowCompilationResult {
  for (const item of evaluations) {
    if (item.evaluation.type === "error") {
      return {
        type: "error",
        bindingId: item.binding.id,
        policyKey: item.evaluation.policyKey,
        error: item.evaluation.error,
      };
    }
  }

  const flows = [...evaluations]
    .sort((left, right) => compareBindings(left.binding, right.binding))
    .flatMap((item) =>
      item.evaluation.type === "matched" && item.evaluation.flow.type !== "none"
        ? [item.evaluation.flow]
        : [],
    );

  if (flows.length === 0) return { type: "compiled", flow: { type: "none" } };
  if (flows.length === 1) return { type: "compiled", flow: flows[0] as FlowDefinition };

  return {
    type: "compiled",
    flow: {
      type: "serial",
      children: flows,
      ...(defaultFlowConstraints ? { constraints: defaultFlowConstraints } : {}),
    },
  };
}

/** Binding選択→Policy評価→Flow合成を外部I/Oなしで一括実行する。 */
export function evaluateApprovalPlan(input: {
  context: PolicyEvaluationContext;
  bindings: readonly ApprovalPolicyBinding[];
  policies: readonly ApprovalPolicyDefinition[];
}): ApprovalPlanEvaluationResult {
  const resolved = resolvePolicyBindings(input.bindings, input.context);
  if (resolved.type === "error") {
    return {
      type: "error",
      stage: "binding",
      bindingId: resolved.bindingId,
      error: resolved.error,
    };
  }

  const policyEvaluations: EvaluatedPolicyBinding[] = [];
  for (const binding of resolved.bindings) {
    const policy = input.policies.find(
      (candidate) => String(candidate.key) === String(binding.policyKey),
    );
    if (!policy) {
      return {
        type: "error",
        stage: "policy_resolution",
        bindingId: binding.id,
        policyKey: binding.policyKey,
        error: {
          code: "policy_not_found",
          message: `Bindingが参照するPolicyが見つかりません: ${String(binding.policyKey)}`,
        },
      };
    }

    const evaluation = evaluatePolicy(policy, input.context);
    if (evaluation.type === "error") {
      return {
        type: "error",
        stage: "policy",
        bindingId: binding.id,
        policyKey: policy.key,
        error: evaluation.error,
      };
    }
    policyEvaluations.push({ binding, evaluation });
  }

  const compiled = compileApprovalFlow(
    policyEvaluations,
    input.context.organization.defaultFlowConstraints,
  );
  if (compiled.type === "error") {
    return {
      type: "error",
      stage: "policy",
      bindingId: compiled.bindingId,
      policyKey: compiled.policyKey,
      error: compiled.error,
    };
  }

  return {
    type: "compiled",
    flow: compiled.flow,
    applicableBindings: resolved.bindings,
    policyEvaluations,
  };
}
