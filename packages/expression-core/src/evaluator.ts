import { Result } from "@praha/byethrow";

import type { Condition, ValueExpression, ValueTemplate } from "./condition.ts";
import { ExpressionTypeMismatchError } from "./errors.ts";
import type { ExpressionError } from "./errors.ts";
import { equalJson } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { validateJsonValue } from "./resolver.ts";
import type { FieldResolver } from "./resolver.ts";

export type ConditionEvaluation = { type: "matched" } | { type: "not_matched" };

export type ConditionEvaluationResult = Result.Result<ConditionEvaluation, ExpressionError>;

export type ValueEvaluationResult = Result.Result<JsonValue, ExpressionError>;

const matched = (): ConditionEvaluationResult => Result.succeed({ type: "matched" as const });
const notMatched = (): ConditionEvaluationResult =>
  Result.succeed({ type: "not_matched" as const });

/** ValueExpressionを値へ解決する。literalもJSON-safeであることを検証する。 */
export function evaluateValueExpression(
  expression: ValueExpression,
  resolver: FieldResolver,
): ValueEvaluationResult {
  if (expression.type === "field") return resolver.resolve(expression.path);
  return validateJsonValue(expression.value);
}

/** ValueTemplateを固定contextから決定的に組み立てる。1つでも解決できなければfail-closed。 */
export function evaluateValueTemplate(
  template: ValueTemplate,
  resolver: FieldResolver,
): ValueEvaluationResult {
  if (template.type === "literal" || template.type === "field") {
    return evaluateValueExpression(template, resolver);
  }
  if (template.type === "array") {
    const items: JsonValue[] = [];
    for (const item of template.items) {
      const value = evaluateValueTemplate(item, resolver);
      if (Result.isFailure(value)) return value;
      items.push(value.value);
    }
    return Result.succeed(items);
  }
  const fields: JsonObject = {};
  for (const [key, child] of Object.entries(template.fields)) {
    const value = evaluateValueTemplate(child, resolver);
    if (Result.isFailure(value)) return value;
    fields[key] = value.value;
  }
  return Result.succeed(fields);
}

function compareOrdered(
  operator: "gt" | "gte" | "lt" | "lte",
  left: number | string,
  right: number | string,
): boolean {
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  return left <= right;
}

function evaluateComparison(
  condition: Extract<Condition, { type: "comparison" }>,
  resolver: FieldResolver,
): ConditionEvaluationResult {
  const left = evaluateValueExpression(condition.left, resolver);
  if (Result.isFailure(left)) return left;
  const right = evaluateValueExpression(condition.right, resolver);
  if (Result.isFailure(right)) return right;

  if (condition.operator === "eq" || condition.operator === "ne") {
    const equal = equalJson(left.value, right.value);
    return (condition.operator === "eq" ? equal : !equal) ? matched() : notMatched();
  }

  if (
    (typeof left.value === "number" && typeof right.value === "number") ||
    (typeof left.value === "string" && typeof right.value === "string")
  ) {
    return compareOrdered(condition.operator, left.value, right.value) ? matched() : notMatched();
  }

  return Result.fail(
    new ExpressionTypeMismatchError({
      code: "type_mismatch",
      path: undefined,
      detail: `順序比較${condition.operator}の左右は同じ比較可能型である必要があります。`,
    }),
  );
}

/**
 * 共有Condition評価器。pureかつ決定的で、外部I/Oを行わない（値はresolverが固定contextから返す）。
 * field欠落・型不一致・許可外pathは「不一致」ではなくerrorとして返し、呼び出し側でfail-closedにする。
 */
export function evaluateCondition(
  condition: Condition,
  resolver: FieldResolver,
): ConditionEvaluationResult {
  switch (condition.type) {
    case "comparison":
      return evaluateComparison(condition, resolver);
    case "and": {
      const results = condition.conditions.map((child) => evaluateCondition(child, resolver));
      const error = results.find(Result.isFailure);
      if (error) return error;
      return results.every((result) => Result.isSuccess(result) && result.value.type === "matched")
        ? matched()
        : notMatched();
    }
    case "or": {
      const results = condition.conditions.map((child) => evaluateCondition(child, resolver));
      const error = results.find(Result.isFailure);
      if (error) return error;
      return results.some((result) => Result.isSuccess(result) && result.value.type === "matched")
        ? matched()
        : notMatched();
    }
    case "not": {
      const result = evaluateCondition(condition.condition, resolver);
      if (Result.isFailure(result)) return result;
      return result.value.type === "matched" ? notMatched() : matched();
    }
    case "in": {
      const value = evaluateValueExpression(condition.value, resolver);
      if (Result.isFailure(value)) return value;
      for (const candidateExpression of condition.candidates) {
        const candidate = evaluateValueExpression(candidateExpression, resolver);
        if (Result.isFailure(candidate)) return candidate;
        if (equalJson(value.value, candidate.value)) return matched();
      }
      return notMatched();
    }
    case "contains": {
      const collection = evaluateValueExpression(condition.collection, resolver);
      if (Result.isFailure(collection)) return collection;
      const value = evaluateValueExpression(condition.value, resolver);
      if (Result.isFailure(value)) return value;

      if (typeof collection.value === "string" && typeof value.value === "string") {
        return collection.value.includes(value.value) ? matched() : notMatched();
      }
      if (Array.isArray(collection.value)) {
        return collection.value.some((item) => equalJson(item, value.value))
          ? matched()
          : notMatched();
      }
      return Result.fail(
        new ExpressionTypeMismatchError({
          code: "type_mismatch",
          path: undefined,
          detail: "containsのcollectionは文字列または配列である必要があります。",
        }),
      );
    }
  }
}
