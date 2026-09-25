import { ErrorFactory } from "@praha/error-factory";

export class ExpressionFieldNotAllowedError extends ErrorFactory({
  name: "ExpressionFieldNotAllowedError",
  message: ({ path, reason }) =>
    reason === "unsafe"
      ? `安全でないfield pathです: ${path}`
      : `このcontextから参照できないfield pathです: ${path}`,
  fields: ErrorFactory.fields<{
    code: "field_not_allowed";
    path: string;
    reason: "not_allowed" | "unsafe";
  }>(),
}) {}

export class ExpressionFieldMissingError extends ErrorFactory({
  name: "ExpressionFieldMissingError",
  message: ({ path }) => `fieldが存在しません: ${path}`,
  fields: ErrorFactory.fields<{
    code: "field_missing";
    path: string;
  }>(),
}) {}

export class ExpressionInvalidValueError extends ErrorFactory({
  name: "ExpressionInvalidValueError",
  message: "式評価ではJSONとして表現できる値だけを利用できます。",
  fields: ErrorFactory.fields<{
    code: "invalid_value";
    path: string | undefined;
  }>(),
}) {}

export class ExpressionTypeMismatchError extends ErrorFactory({
  name: "ExpressionTypeMismatchError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{
    code: "type_mismatch";
    path: string | undefined;
    detail: string;
  }>(),
}) {}

export class ExpressionInvalidNumberError extends ErrorFactory({
  name: "ExpressionInvalidNumberError",
  message: "式評価では有限かつ安全に表現できる数値だけを利用できます。",
  fields: ErrorFactory.fields<{
    code: "invalid_number";
    path: string | undefined;
  }>(),
}) {}

export class ExpressionInvalidDateError extends ErrorFactory({
  name: "ExpressionInvalidDateError",
  message: ({ path }) => `${path}は有効な日時文字列である必要があります。`,
  fields: ErrorFactory.fields<{
    code: "invalid_date";
    path: string;
  }>(),
}) {}

/** 式評価のfail-closedな失敗。どれも「条件不成立」とは区別して呼び出し側へ返す。 */
export type ExpressionError =
  | ExpressionFieldNotAllowedError
  | ExpressionFieldMissingError
  | ExpressionInvalidValueError
  | ExpressionTypeMismatchError
  | ExpressionInvalidNumberError
  | ExpressionInvalidDateError;
