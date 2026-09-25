import { Result } from "@praha/byethrow";

import {
  ExpressionFieldMissingError,
  ExpressionFieldNotAllowedError,
  ExpressionInvalidDateError,
  ExpressionInvalidNumberError,
  ExpressionInvalidValueError,
} from "./errors.ts";
import type { ExpressionError } from "./errors.ts";
import { jsonValueIssue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { isFieldPathAllowed, isUnsafeFieldSegment } from "./namespace.ts";
import type { FieldNamespacePolicy } from "./namespace.ts";

export type FieldResolution = Result.Result<JsonValue, ExpressionError>;

/**
 * field pathを、外部I/O解決済みの固定contextから値へ解決するport。
 * bounded contextごとに実装し、参照できるnamespaceを明示的に制限する。
 */
export interface FieldResolver {
  resolve(path: string): FieldResolution;
}

/** 実行時の値をJSON-safeな値として検証する。 */
export function validateJsonValue(value: unknown, path?: string): FieldResolution {
  const issue = jsonValueIssue(value);
  if (issue === "invalid_number") {
    return Result.fail(new ExpressionInvalidNumberError({ code: "invalid_number", path }));
  }
  if (issue === "invalid_value") {
    return Result.fail(new ExpressionInvalidValueError({ code: "invalid_value", path }));
  }
  return Result.succeed(value as JsonValue);
}

/**
 * plain objectのcontextを"."区切りで辿るField Resolver。
 *
 * - policy外のpathはfield_not_allowed（評価前にfail-closed）
 * - `__proto__` / `prototype` / `constructor`はunsafeとして拒否
 * - 自身のpropertyとして存在しないsegmentはfield_missing
 * - 解決値がJSON-safeでなければinvalid_value / invalid_number
 * - dateTimeFieldsに含まれるpathは有効な日時文字列であることを検証する
 */
export function createFieldResolver(input: {
  policy: FieldNamespacePolicy;
  root: unknown;
  dateTimeFields?: readonly string[];
}): FieldResolver {
  const dateTimeFields = new Set(input.dateTimeFields ?? []);
  return {
    resolve(path: string): FieldResolution {
      if (!isFieldPathAllowed(input.policy, path)) {
        return Result.fail(
          new ExpressionFieldNotAllowedError({
            code: "field_not_allowed",
            path,
            reason: "not_allowed",
          }),
        );
      }

      let current: unknown = input.root;
      for (const segment of path.split(".")) {
        if (isUnsafeFieldSegment(segment)) {
          return Result.fail(
            new ExpressionFieldNotAllowedError({
              code: "field_not_allowed",
              path,
              reason: "unsafe",
            }),
          );
        }
        if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
          return Result.fail(new ExpressionFieldMissingError({ code: "field_missing", path }));
        }
        current = (current as Record<string, unknown>)[segment];
      }

      if (dateTimeFields.has(path)) {
        if (typeof current !== "string" || !Number.isFinite(Date.parse(current))) {
          return Result.fail(new ExpressionInvalidDateError({ code: "invalid_date", path }));
        }
        return Result.succeed(current);
      }

      return validateJsonValue(current, path);
    },
  };
}
