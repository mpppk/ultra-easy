import type { JsonValue } from "./json.ts";

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

export type Condition =
  | ComparisonCondition
  | AndCondition
  | OrCondition
  | NotCondition
  | InCondition
  | ContainsCondition;

export type AlwaysCondition = {
  type: "always";
};
