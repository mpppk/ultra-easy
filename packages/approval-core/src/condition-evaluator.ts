import type { Condition, ValueExpression } from "./domain/condition.ts";
import type { JsonValue } from "./domain/json.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";

export type ConditionEvaluationError = {
  type: "error";
  code:
    | "field_not_allowed"
    | "field_missing"
    | "invalid_value"
    | "type_mismatch"
    | "invalid_number"
    | "invalid_date";
  path?: string;
  message: string;
};

export type ConditionEvaluationResult =
  | { type: "matched" }
  | { type: "not_matched" }
  | ConditionEvaluationError;

type ValueResolutionResult =
  | { type: "resolved"; value: JsonValue }
  | ConditionEvaluationError;

const ALLOWED_FIELD_PREFIXES = [
  "action.input",
  "actor",
  "authority",
  "origin",
  "organization.settings",
  "attributes",
] as const;

export function isAllowedPolicyFieldPath(path: string): boolean {
  if (path === "now") {
    return true;
  }

  return ALLOWED_FIELD_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRuntimeValue(value: unknown, path?: string): ConditionEvaluationError | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return {
        type: "error",
        code: "invalid_number",
        path,
        message: "Policy評価では有限かつ安全に表現できる数値だけを利用できます。",
      };
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const error = invalidRuntimeValue(item, path);
      if (error) return error;
    }
    return undefined;
  }

  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) {
      const error = invalidRuntimeValue(item, path);
      if (error) return error;
    }
    return undefined;
  }

  return {
    type: "error",
    code: "invalid_value",
    path,
    message: "Policy評価ではJSONとして表現できる値だけを利用できます。",
  };
}

function resolveField(path: string, context: PolicyEvaluationContext): ValueResolutionResult {
  if (!isAllowedPolicyFieldPath(path)) {
    return {
      type: "error",
      code: "field_not_allowed",
      path,
      message: `Policyから参照できないfield pathです: ${path}`,
    };
  }

  if (path === "now") {
    if (!Number.isFinite(Date.parse(context.now))) {
      return {
        type: "error",
        code: "invalid_date",
        path,
        message: "nowは有効な日時文字列である必要があります。",
      };
    }
    return { type: "resolved", value: context.now };
  }

  const segments = path.split(".");
  let current: unknown = context;

  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return {
        type: "error",
        code: "field_not_allowed",
        path,
        message: `安全でないfield pathです: ${path}`,
      };
    }

    if ((typeof current !== "object" || current === null) || !Object.hasOwn(current, segment)) {
      return {
        type: "error",
        code: "field_missing",
        path,
        message: `fieldが存在しません: ${path}`,
      };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  const error = invalidRuntimeValue(current, path);
  if (error) return error;

  return { type: "resolved", value: current as JsonValue };
}

function resolveValue(expression: ValueExpression, context: PolicyEvaluationContext): ValueResolutionResult {
  if (expression.type === "field") {
    return resolveField(expression.path, context);
  }

  const error = invalidRuntimeValue(expression.value);
  if (error) return error;
  return { type: "resolved", value: expression.value };
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalJson(value, right[index] as JsonValue));
  }

  if (isRecord(left)) {
    if (!isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) => equalJson(left[key] as JsonValue, right[key] as JsonValue));
  }

  return false;
}

function evaluateComparison(
  condition: Extract<Condition, { type: "comparison" }>,
  context: PolicyEvaluationContext,
): ConditionEvaluationResult {
  const left = resolveValue(condition.left, context);
  if (left.type === "error") return left;
  const right = resolveValue(condition.right, context);
  if (right.type === "error") return right;

  if (condition.operator === "eq" || condition.operator === "ne") {
    const equal = equalJson(left.value, right.value);
    return (condition.operator === "eq" ? equal : !equal)
      ? { type: "matched" }
      : { type: "not_matched" };
  }

  if (typeof left.value === "number" && typeof right.value === "number") {
    const matched =
      condition.operator === "gt"
        ? left.value > right.value
        : condition.operator === "gte"
          ? left.value >= right.value
          : condition.operator === "lt"
            ? left.value < right.value
            : left.value <= right.value;
    return matched ? { type: "matched" } : { type: "not_matched" };
  }

  if (typeof left.value === "string" && typeof right.value === "string") {
    const matched =
      condition.operator === "gt"
        ? left.value > right.value
        : condition.operator === "gte"
          ? left.value >= right.value
          : condition.operator === "lt"
            ? left.value < right.value
            : left.value <= right.value;
    return matched ? { type: "matched" } : { type: "not_matched" };
  }

  return {
    type: "error",
    code: "type_mismatch",
    message: `順序比較${condition.operator}の左右は同じ比較可能型である必要があります。`,
  };
}

export function evaluateCondition(
  condition: Condition,
  context: PolicyEvaluationContext,
): ConditionEvaluationResult {
  switch (condition.type) {
    case "comparison":
      return evaluateComparison(condition, context);
    case "and": {
      const results = condition.conditions.map((child) => evaluateCondition(child, context));
      const error = results.find((result): result is ConditionEvaluationError => result.type === "error");
      if (error) return error;
      return results.every((result) => result.type === "matched")
        ? { type: "matched" }
        : { type: "not_matched" };
    }
    case "or": {
      const results = condition.conditions.map((child) => evaluateCondition(child, context));
      const error = results.find((result): result is ConditionEvaluationError => result.type === "error");
      if (error) return error;
      return results.some((result) => result.type === "matched")
        ? { type: "matched" }
        : { type: "not_matched" };
    }
    case "not": {
      const result = evaluateCondition(condition.condition, context);
      if (result.type === "error") return result;
      return result.type === "matched" ? { type: "not_matched" } : { type: "matched" };
    }
    case "in": {
      const value = resolveValue(condition.value, context);
      if (value.type === "error") return value;
      for (const candidateExpression of condition.candidates) {
        const candidate = resolveValue(candidateExpression, context);
        if (candidate.type === "error") return candidate;
        if (equalJson(value.value, candidate.value)) return { type: "matched" };
      }
      return { type: "not_matched" };
    }
    case "contains": {
      const collection = resolveValue(condition.collection, context);
      if (collection.type === "error") return collection;
      const value = resolveValue(condition.value, context);
      if (value.type === "error") return value;

      if (typeof collection.value === "string" && typeof value.value === "string") {
        return collection.value.includes(value.value) ? { type: "matched" } : { type: "not_matched" };
      }
      if (Array.isArray(collection.value)) {
        return collection.value.some((item) => equalJson(item, value.value))
          ? { type: "matched" }
          : { type: "not_matched" };
      }
      return {
        type: "error",
        code: "type_mismatch",
        message: "containsのcollectionは文字列または配列である必要があります。",
      };
    }
  }
}
