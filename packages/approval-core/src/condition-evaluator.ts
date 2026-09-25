import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import {
  APPROVAL_FIELD_NAMESPACES,
  createFieldResolver,
  evaluateCondition as evaluateSharedCondition,
  isFieldPathAllowed,
} from "@app/expression-core";
import type { ExpressionError, FieldResolver } from "@app/expression-core";

import type { Condition } from "./domain/condition.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";

export class PolicyFieldNotAllowedError extends ErrorFactory({
  name: "PolicyFieldNotAllowedError",
  message: ({ path, reason }) =>
    reason === "unsafe"
      ? `安全でないfield pathです: ${path}`
      : `Policyから参照できないfield pathです: ${path}`,
  fields: ErrorFactory.fields<{
    code: "field_not_allowed";
    path: string;
    reason: "not_allowed" | "unsafe";
  }>(),
}) {}

export class PolicyFieldMissingError extends ErrorFactory({
  name: "PolicyFieldMissingError",
  message: ({ path }) => `fieldが存在しません: ${path}`,
  fields: ErrorFactory.fields<{
    code: "field_missing";
    path: string;
  }>(),
}) {}

export class PolicyInvalidValueError extends ErrorFactory({
  name: "PolicyInvalidValueError",
  message: "Policy評価ではJSONとして表現できる値だけを利用できます。",
  fields: ErrorFactory.fields<{
    code: "invalid_value";
    path: string | undefined;
  }>(),
}) {}

export class PolicyTypeMismatchError extends ErrorFactory({
  name: "PolicyTypeMismatchError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{
    code: "type_mismatch";
    path: string | undefined;
    detail: string;
  }>(),
}) {}

export class PolicyInvalidNumberError extends ErrorFactory({
  name: "PolicyInvalidNumberError",
  message: "Policy評価では有限かつ安全に表現できる数値だけを利用できます。",
  fields: ErrorFactory.fields<{
    code: "invalid_number";
    path: string | undefined;
  }>(),
}) {}

export class PolicyInvalidDateError extends ErrorFactory({
  name: "PolicyInvalidDateError",
  message: "nowは有効な日時文字列である必要があります。",
  fields: ErrorFactory.fields<{
    code: "invalid_date";
    path: string;
  }>(),
}) {}

export type ConditionEvaluationError =
  | PolicyFieldNotAllowedError
  | PolicyFieldMissingError
  | PolicyInvalidValueError
  | PolicyTypeMismatchError
  | PolicyInvalidNumberError
  | PolicyInvalidDateError;

export type ConditionEvaluation = { type: "matched" } | { type: "not_matched" };

export type ConditionEvaluationResult = Result.Result<
  ConditionEvaluation,
  ConditionEvaluationError
>;

const matched = (): ConditionEvaluationResult => Result.succeed({ type: "matched" as const });
const notMatched = (): ConditionEvaluationResult =>
  Result.succeed({ type: "not_matched" as const });

export function isAllowedPolicyFieldPath(path: string): boolean {
  return isFieldPathAllowed(APPROVAL_FIELD_NAMESPACES, path);
}

/**
 * Approval用Field Resolver。参照範囲は`APPROVAL_FIELD_NAMESPACES`に限定し、
 * `now`は有効な日時文字列であることを検証する。
 */
export function approvalFieldResolver(context: PolicyEvaluationContext): FieldResolver {
  return createFieldResolver({
    policy: APPROVAL_FIELD_NAMESPACES,
    root: context,
    dateTimeFields: ["now"],
  });
}

/** 共有評価器のerrorを、既存のPolicy評価error contractへ写像する。 */
function toPolicyError(error: ExpressionError): ConditionEvaluationError {
  switch (error.code) {
    case "field_not_allowed":
      return new PolicyFieldNotAllowedError({
        code: "field_not_allowed",
        path: error.path,
        reason: error.reason,
      });
    case "field_missing":
      return new PolicyFieldMissingError({ code: "field_missing", path: error.path });
    case "invalid_value":
      return new PolicyInvalidValueError({ code: "invalid_value", path: error.path });
    case "type_mismatch":
      return new PolicyTypeMismatchError({
        code: "type_mismatch",
        path: error.path,
        detail: error.detail,
      });
    case "invalid_number":
      return new PolicyInvalidNumberError({ code: "invalid_number", path: error.path });
    case "invalid_date":
      return new PolicyInvalidDateError({ code: "invalid_date", path: error.path });
  }
}

/** Approval Policyの条件を評価する（評価器はexpression-coreと共有、#155）。 */
export function evaluateCondition(
  condition: Condition,
  context: PolicyEvaluationContext,
): ConditionEvaluationResult {
  const result = evaluateSharedCondition(condition, approvalFieldResolver(context));
  if (Result.isFailure(result)) return Result.fail(toPolicyError(result.error));
  return result.value.type === "matched" ? matched() : notMatched();
}
