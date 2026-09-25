import type { JsonValue } from "./json.ts";

/** 条件式・値式が参照する単一の値。fieldはbounded contextごとのField Resolverで解決する。 */
export type ValueExpression =
  | { type: "literal"; value: JsonValue }
  | { type: "field"; path: string };

export type ComparisonOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export type ComparisonCondition = {
  type: "comparison";
  left: ValueExpression;
  operator: ComparisonOperator;
  right: ValueExpression;
};

export type AndCondition = {
  type: "and";
  conditions: Condition[];
};

export type OrCondition = {
  type: "or";
  conditions: Condition[];
};

export type NotCondition = {
  type: "not";
  condition: Condition;
};

export type InCondition = {
  type: "in";
  value: ValueExpression;
  candidates: ValueExpression[];
};

export type ContainsCondition = {
  type: "contains";
  collection: ValueExpression;
  value: ValueExpression;
};

/**
 * Approval Policy / Workflow Branch・Loop / Delegation restrictionで共有する、
 * シリアライズ可能でpureなpredicate。
 */
export type Condition =
  | ComparisonCondition
  | AndCondition
  | OrCondition
  | NotCondition
  | InCondition
  | ContainsCondition;

/**
 * JSON構造の中にValueExpressionを埋め込んだ値テンプレート。
 * Workflowのtransform / Action input等で、固定contextから決定的に値を組み立てる。
 */
export type ValueTemplate =
  | ValueExpression
  | { type: "object"; fields: Record<string, ValueTemplate> }
  | { type: "array"; items: ValueTemplate[] };
