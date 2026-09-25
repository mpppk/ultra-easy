import type { Condition, ValueExpression, ValueTemplate } from "./condition.ts";
import { jsonValueIssue } from "./json.ts";
import { hasUnsafeFieldSegment, isFieldPathAllowed } from "./namespace.ts";
import type { FieldNamespacePolicy } from "./namespace.ts";

export type ExpressionValidationIssue = {
  code: "field_not_allowed" | "unsafe_field_path" | "invalid_literal";
  /** 式の中の位置（例: `$.conditions[0].left`）。 */
  location: string;
  message: string;
};

/** Condition中のValueExpressionを出現順に列挙する。 */
export function conditionValueExpressions(
  condition: Condition,
  location = "$",
): { expression: ValueExpression; location: string }[] {
  switch (condition.type) {
    case "comparison":
      return [
        { expression: condition.left, location: `${location}.left` },
        { expression: condition.right, location: `${location}.right` },
      ];
    case "and":
    case "or":
      return condition.conditions.flatMap((child, index) =>
        conditionValueExpressions(child, `${location}.conditions[${index}]`),
      );
    case "not":
      return conditionValueExpressions(condition.condition, `${location}.condition`);
    case "in":
      return [
        { expression: condition.value, location: `${location}.value` },
        ...condition.candidates.map((candidate, index) => ({
          expression: candidate,
          location: `${location}.candidates[${index}]`,
        })),
      ];
    case "contains":
      return [
        { expression: condition.collection, location: `${location}.collection` },
        { expression: condition.value, location: `${location}.value` },
      ];
  }
}

/** ValueTemplate中のValueExpressionを出現順に列挙する。 */
export function templateValueExpressions(
  template: ValueTemplate,
  location = "$",
): { expression: ValueExpression; location: string }[] {
  if (template.type === "literal" || template.type === "field") {
    return [{ expression: template, location }];
  }
  if (template.type === "array") {
    return template.items.flatMap((item, index) =>
      templateValueExpressions(item, `${location}[${index}]`),
    );
  }
  return Object.entries(template.fields).flatMap(([key, child]) =>
    templateValueExpressions(child, `${location}.${key}`),
  );
}

/** 式が参照するfield pathの一覧（重複あり、出現順）。 */
export function referencedFieldPaths(
  expressions: readonly { expression: ValueExpression }[],
): string[] {
  return expressions.flatMap(({ expression }) =>
    expression.type === "field" ? [expression.path] : [],
  );
}

/**
 * 実行前の静的検証。policy外 / unsafeなfield参照と、JSON-safeでないliteralを検出する。
 * 型や存在は実行時にもfail-closedで検査するため、ここでは実行前に確定できる誤りだけを扱う。
 */
export function validateValueExpressions(
  expressions: readonly { expression: ValueExpression; location: string }[],
  policy: FieldNamespacePolicy,
): ExpressionValidationIssue[] {
  const issues: ExpressionValidationIssue[] = [];
  for (const { expression, location } of expressions) {
    if (expression.type === "field") {
      if (hasUnsafeFieldSegment(expression.path)) {
        issues.push({
          code: "unsafe_field_path",
          location,
          message: `安全でないfield pathです: ${expression.path}`,
        });
      } else if (!isFieldPathAllowed(policy, expression.path)) {
        issues.push({
          code: "field_not_allowed",
          location,
          message: `${policy.context}から参照できないfield pathです: ${expression.path}`,
        });
      }
      continue;
    }
    if (jsonValueIssue(expression.value)) {
      issues.push({
        code: "invalid_literal",
        location,
        message: "literalは有限かつ安全に表現可能なJSON値である必要があります。",
      });
    }
  }
  return issues;
}

export function validateCondition(
  condition: Condition,
  policy: FieldNamespacePolicy,
  location = "$",
): ExpressionValidationIssue[] {
  return validateValueExpressions(conditionValueExpressions(condition, location), policy);
}

export function validateValueTemplate(
  template: ValueTemplate,
  policy: FieldNamespacePolicy,
  location = "$",
): ExpressionValidationIssue[] {
  return validateValueExpressions(templateValueExpressions(template, location), policy);
}
