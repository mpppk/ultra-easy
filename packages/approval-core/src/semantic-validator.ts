import type { Condition, ValueExpression } from "./domain/condition.ts";
import type { PolicyFieldCatalog, PolicyFieldDefinition, PolicyFieldType } from "./domain/evaluation.ts";
import type { ApproverExpression, FlowDefinition } from "./domain/flow.ts";
import type { ApprovalPolicyBinding, ApprovalPolicyDefinition } from "./domain/policy.ts";
import { isAllowedPolicyFieldPath } from "./condition-evaluator.ts";

export const MAX_EXPLICIT_EXPIRY_SECONDS = 365 * 24 * 60 * 60;

export type SemanticValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type SemanticValidationResult =
  | { valid: true }
  | { valid: false; issues: SemanticValidationIssue[] };

export type PolicySemanticValidationOptions = {
  fieldCatalog?: PolicyFieldCatalog;
  maxExpirySeconds?: number;
};

type ExpressionType = PolicyFieldType | "null" | "object" | "array" | "unknown";

type CurrencyGuards = {
  literalPaths: Set<string>;
  equalPathPairs: Set<string>;
};

function addIssue(
  issues: SemanticValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

function findField(
  catalog: PolicyFieldCatalog | undefined,
  path: string,
): PolicyFieldDefinition | undefined {
  return catalog?.find((field) => field.path === path);
}

function literalType(value: unknown): ExpressionType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

function expressionType(
  expression: ValueExpression,
  catalog: PolicyFieldCatalog | undefined,
): ExpressionType {
  if (expression.type === "literal") return literalType(expression.value);
  if (expression.path === "now") return "date_time";
  return findField(catalog, expression.path)?.type ?? "unknown";
}

function collectCurrencyGuards(conditions: readonly Condition[]): CurrencyGuards {
  const guards: CurrencyGuards = { literalPaths: new Set(), equalPathPairs: new Set() };

  for (const condition of conditions) {
    if (condition.type !== "comparison" || condition.operator !== "eq") continue;

    const { left, right } = condition;
    if (left.type === "field" && right.type === "literal" && typeof right.value === "string") {
      guards.literalPaths.add(left.path);
    } else if (
      right.type === "field" &&
      left.type === "literal" &&
      typeof left.value === "string"
    ) {
      guards.literalPaths.add(right.path);
    } else if (left.type === "field" && right.type === "field") {
      guards.equalPathPairs.add(pairKey(left.path, right.path));
    }
  }

  return guards;
}

function mergeCurrencyGuards(parent: CurrencyGuards, local: CurrencyGuards): CurrencyGuards {
  return {
    literalPaths: new Set([...parent.literalPaths, ...local.literalPaths]),
    equalPathPairs: new Set([...parent.equalPathPairs, ...local.equalPathPairs]),
  };
}

function validateValueExpression(
  expression: ValueExpression,
  path: string,
  issues: SemanticValidationIssue[],
): void {
  if (expression.type === "field" && !isAllowedPolicyFieldPath(expression.path)) {
    addIssue(
      issues,
      "unknown_field_root",
      path,
      `Policyから参照できないfield pathです: ${expression.path}`,
    );
  }

  if (
    expression.type === "literal" &&
    typeof expression.value === "number" &&
    (!Number.isFinite(expression.value) ||
      (Number.isInteger(expression.value) && !Number.isSafeInteger(expression.value)))
  ) {
    addIssue(issues, "invalid_number", path, "数値literalは有限かつ安全に表現可能である必要があります。");
  }
}

function orderedTypesCompatible(left: ExpressionType, right: ExpressionType): boolean {
  if (left === "unknown" || right === "unknown") return true;
  if (left === "number" && right === "number") return true;
  if (left === "string" && right === "string") return true;
  if (left === "date_time" && (right === "date_time" || right === "string")) return true;
  if (right === "date_time" && left === "string") return true;
  if (left === "money_minor" && (right === "money_minor" || right === "number")) return true;
  if (right === "money_minor" && left === "number") return true;
  return false;
}

function validateMoneyComparison(
  left: ValueExpression,
  right: ValueExpression,
  path: string,
  catalog: PolicyFieldCatalog | undefined,
  guards: CurrencyGuards,
  issues: SemanticValidationIssue[],
): void {
  const leftMoney = left.type === "field" ? findField(catalog, left.path) : undefined;
  const rightMoney = right.type === "field" ? findField(catalog, right.path) : undefined;
  const leftIsMoney = leftMoney?.type === "money_minor";
  const rightIsMoney = rightMoney?.type === "money_minor";

  if (!leftIsMoney && !rightIsMoney) return;

  for (const moneyField of [leftMoney, rightMoney]) {
    if (moneyField?.type === "money_minor" && !moneyField.currencyPath) {
      addIssue(
        issues,
        "money_currency_path_missing",
        path,
        `money_minor field ${moneyField.path} にはcurrencyPathが必要です。`,
      );
    }
  }

  if (leftIsMoney && rightIsMoney) {
    const leftCurrency = leftMoney?.currencyPath;
    const rightCurrency = rightMoney?.currencyPath;
    if (
      leftCurrency &&
      rightCurrency &&
      leftCurrency !== rightCurrency &&
      !guards.equalPathPairs.has(pairKey(leftCurrency, rightCurrency))
    ) {
      addIssue(
        issues,
        "money_currency_guard_required",
        path,
        "異なるcurrency fieldを持つ金額同士の比較にはcurrency一致条件が必要です。",
      );
    }
    return;
  }

  const moneyField = leftIsMoney ? leftMoney : rightMoney;
  if (moneyField?.currencyPath && !guards.literalPaths.has(moneyField.currencyPath)) {
    addIssue(
      issues,
      "money_currency_guard_required",
      path,
      `金額とliteralの比較には${moneyField.currencyPath}の通貨条件が必要です。`,
    );
  }
}

function validateCondition(
  condition: Condition,
  path: string,
  issues: SemanticValidationIssue[],
  options: PolicySemanticValidationOptions,
  inheritedGuards: CurrencyGuards = { literalPaths: new Set(), equalPathPairs: new Set() },
): void {
  switch (condition.type) {
    case "comparison": {
      validateValueExpression(condition.left, `${path}.left`, issues);
      validateValueExpression(condition.right, `${path}.right`, issues);

      if (["gt", "gte", "lt", "lte"].includes(condition.operator)) {
        const leftType = expressionType(condition.left, options.fieldCatalog);
        const rightType = expressionType(condition.right, options.fieldCatalog);
        if (!orderedTypesCompatible(leftType, rightType)) {
          addIssue(
            issues,
            "unsupported_type_comparison",
            path,
            `順序比較できない型です: ${leftType} ${condition.operator} ${rightType}`,
          );
        }
        validateMoneyComparison(
          condition.left,
          condition.right,
          path,
          options.fieldCatalog,
          inheritedGuards,
          issues,
        );
      }
      return;
    }
    case "and": {
      const guards = mergeCurrencyGuards(inheritedGuards, collectCurrencyGuards(condition.conditions));
      condition.conditions.forEach((child, index) =>
        validateCondition(child, `${path}.conditions[${index}]`, issues, options, guards),
      );
      return;
    }
    case "or":
      condition.conditions.forEach((child, index) =>
        validateCondition(child, `${path}.conditions[${index}]`, issues, options, inheritedGuards),
      );
      return;
    case "not":
      validateCondition(condition.condition, `${path}.condition`, issues, options, inheritedGuards);
      return;
    case "in":
      validateValueExpression(condition.value, `${path}.value`, issues);
      condition.candidates.forEach((candidate, index) =>
        validateValueExpression(candidate, `${path}.candidates[${index}]`, issues),
      );
      return;
    case "contains":
      validateValueExpression(condition.collection, `${path}.collection`, issues);
      validateValueExpression(condition.value, `${path}.value`, issues);
      return;
  }
}

function validateApproverExpression(
  approver: ApproverExpression,
  path: string,
  issues: SemanticValidationIssue[],
): void {
  if (approver.type === "relation" && approver.object.type === "reference") {
    validateValueExpression(approver.object.id, `${path}.object.id`, issues);
  } else if (approver.type === "user") {
    validateValueExpression(approver.userId, `${path}.userId`, issues);
  }
}

function validateFlow(
  flow: FlowDefinition,
  path: string,
  issues: SemanticValidationIssue[],
  stepKeys: Set<string>,
  options: PolicySemanticValidationOptions,
): void {
  if (flow.type === "none") {
    if ("children" in flow) {
      addIssue(issues, "none_has_children", path, "none Flowはchildを持てません。");
    }
    return;
  }

  if (flow.type === "serial") {
    if (!Array.isArray(flow.children) || flow.children.length === 0) {
      addIssue(issues, "empty_serial", `${path}.children`, "serial.childrenは1件以上必要です。");
      return;
    }
    flow.children.forEach((child, index) =>
      validateFlow(child, `${path}.children[${index}]`, issues, stepKeys, options),
    );
    return;
  }

  if (flow.type === "parallel") {
    if (!Array.isArray(flow.children) || flow.children.length === 0) {
      addIssue(issues, "empty_parallel", `${path}.children`, "parallel.childrenは1件以上必要です。");
      return;
    }

    const strategy = (flow as { strategy?: unknown }).strategy;
    if (strategy !== "all" && strategy !== "any" && strategy !== "quorum") {
      addIssue(issues, "invalid_parallel_strategy", `${path}.strategy`, "未対応のparallel strategyです。");
    } else if (strategy === "quorum") {
      const quorum = (flow as { quorum?: unknown }).quorum;
      if (
        typeof quorum !== "number" ||
        !Number.isSafeInteger(quorum) ||
        quorum < 1 ||
        quorum > flow.children.length
      ) {
        addIssue(
          issues,
          "invalid_quorum",
          `${path}.quorum`,
          "quorumは1以上かつchildren数以下の整数である必要があります。",
        );
      }
    } else if ("quorum" in flow && flow.quorum !== undefined) {
      addIssue(issues, "unexpected_quorum", `${path}.quorum`, "quorum strategy以外ではquorumを指定できません。");
    }

    flow.children.forEach((child, index) =>
      validateFlow(child, `${path}.children[${index}]`, issues, stepKeys, options),
    );
    return;
  }

  const key = String(flow.key);
  if (stepKeys.has(key)) {
    addIssue(issues, "duplicate_step_key", `${path}.key`, `Step keyが重複しています: ${key}`);
  }
  stepKeys.add(key);

  validateApproverExpression(flow.approver, `${path}.approver`, issues);

  const completion = (flow as { candidateCompletion?: unknown }).candidateCompletion;
  const completionNeedsSnapshot =
    completion === "all" ||
    (typeof completion === "object" &&
      completion !== null &&
      (completion as { type?: unknown }).type === "quorum");

  if (typeof completion === "object" && completion !== null) {
    const candidate = completion as { type?: unknown; count?: unknown };
    if (
      candidate.type !== "quorum" ||
      typeof candidate.count !== "number" ||
      !Number.isSafeInteger(candidate.count) ||
      candidate.count < 1
    ) {
      addIssue(
        issues,
        "invalid_candidate_completion",
        `${path}.candidateCompletion`,
        "candidateCompletion.quorumは1以上の整数である必要があります。",
      );
    }
  } else if (completion !== undefined && completion !== "any" && completion !== "all") {
    addIssue(
      issues,
      "invalid_candidate_completion",
      `${path}.candidateCompletion`,
      "未対応のcandidateCompletionです。",
    );
  }

  if (completionNeedsSnapshot && flow.resolution !== "snapshot") {
    addIssue(
      issues,
      "candidate_completion_requires_snapshot",
      `${path}.resolution`,
      "candidateCompletion=all/quorumではresolution=snapshotが必要です。",
    );
  }

  const unresolved = (flow as { onUnresolved?: { type?: unknown; approver?: unknown } }).onUnresolved;
  if (unresolved && unresolved.type !== "deny" && unresolved.type !== "fallback") {
    addIssue(
      issues,
      "invalid_unresolved_strategy",
      `${path}.onUnresolved`,
      "v1のonUnresolvedはdenyまたはfallbackのみです。",
    );
  } else if (unresolved?.type === "fallback" && !unresolved.approver) {
    addIssue(
      issues,
      "invalid_unresolved_strategy",
      `${path}.onUnresolved.approver`,
      "fallbackにはapproverが必要です。",
    );
  }

  if (flow.expiresAfter) {
    const max = options.maxExpirySeconds ?? MAX_EXPLICIT_EXPIRY_SECONDS;
    const seconds = flow.expiresAfter.seconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > max) {
      addIssue(
        issues,
        "invalid_expiry",
        `${path}.expiresAfter.seconds`,
        `expiresAfter.secondsは1以上${max}以下の整数である必要があります。`,
      );
    }
  }

  if (flow.requireCommentOn) {
    for (const [index, decision] of flow.requireCommentOn.entries()) {
      if (decision !== "approve" && decision !== "reject") {
        addIssue(
          issues,
          "invalid_comment_requirement",
          `${path}.requireCommentOn[${index}]`,
          "requireCommentOnにはapprove/rejectだけを指定できます。",
        );
      }
    }
  }
}

export function validateApprovalPolicySemantics(
  policy: ApprovalPolicyDefinition,
  options: PolicySemanticValidationOptions = {},
): SemanticValidationResult {
  const issues: SemanticValidationIssue[] = [];

  if (policy.schemaVersion !== 1) {
    addIssue(issues, "unsupported_schema_version", "schemaVersion", "schemaVersion=1だけをサポートします。");
  }

  const ruleKeys = new Set<string>();
  const stepKeys = new Set<string>();

  policy.rules.forEach((rule, index) => {
    const rulePath = `rules[${index}]`;
    const key = String(rule.key);
    if (ruleKeys.has(key)) {
      addIssue(issues, "duplicate_rule_key", `${rulePath}.key`, `Rule keyが重複しています: ${key}`);
    }
    ruleKeys.add(key);

    if (rule.when.type === "always") {
      if (index !== policy.rules.length - 1) {
        addIssue(issues, "always_not_last", `${rulePath}.when`, "always Ruleは最後にだけ配置できます。");
      }
    } else {
      validateCondition(rule.when, `${rulePath}.when`, issues, options);
    }

    validateFlow(rule.flow, `${rulePath}.flow`, issues, stepKeys, options);
  });

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

export function isValidActionTypePattern(value: string): boolean {
  const firstWildcard = value.indexOf("*");
  if (firstWildcard === -1) return value.length > 0;
  return firstWildcard === value.length - 1 && firstWildcard > 0 && value.lastIndexOf("*") === firstWildcard;
}

export function validateApprovalPolicyBindingSemantics(
  binding: ApprovalPolicyBinding,
  options: PolicySemanticValidationOptions = {},
): SemanticValidationResult {
  const issues: SemanticValidationIssue[] = [];

  if (binding.selector.actionTypes.length === 0) {
    addIssue(issues, "empty_action_selector", "selector.actionTypes", "actionTypesは1件以上必要です。");
  }

  binding.selector.actionTypes.forEach((actionType, index) => {
    if (!isValidActionTypePattern(String(actionType))) {
      addIssue(
        issues,
        "invalid_action_type_pattern",
        `selector.actionTypes[${index}]`,
        "Action typeは完全一致または末尾*のprefix patternだけを利用できます。",
      );
    }
  });

  if (binding.selector.resourceTypes?.length === 0) {
    addIssue(issues, "empty_resource_selector", "selector.resourceTypes", "resourceTypesは指定するなら1件以上必要です。");
  }

  if (
    binding.compositionOrder !== undefined &&
    !Number.isSafeInteger(binding.compositionOrder)
  ) {
    addIssue(
      issues,
      "invalid_composition_order",
      "compositionOrder",
      "compositionOrderは安全な整数である必要があります。",
    );
  }

  if (binding.selector.when) {
    validateCondition(binding.selector.when, "selector.when", issues, options);
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}
