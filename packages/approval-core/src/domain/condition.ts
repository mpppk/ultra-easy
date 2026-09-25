// Condition言語はApproval / Workflow / Delegationで共有する（#155 expression-core）。
export type {
  AndCondition,
  ComparisonCondition,
  ComparisonOperator,
  Condition,
  ContainsCondition,
  InCondition,
  NotCondition,
  OrCondition,
  ValueExpression,
} from "@app/expression-core";

export type AlwaysCondition = {
  type: "always";
};
