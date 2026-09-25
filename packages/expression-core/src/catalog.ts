import { Result } from "@praha/byethrow";

import { hasUnsafeFieldSegment, matchFieldNamespace } from "./namespace.ts";
import type { FieldNamespace, FieldNamespacePolicy } from "./namespace.ts";

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date_time"
  | "money_minor"
  | "string_array"
  | "number_array"
  | "boolean_array"
  | "object"
  | "array"
  | "json";

export type FieldDefinition = {
  path: string;
  type: FieldType;
  label?: string;
  description?: string;
  /** type=money_minorのとき、同じ金額の通貨コードを保持するfield path。 */
  currencyPath?: string;
};

export type FieldCatalog = readonly FieldDefinition[];

/**
 * UI（Condition Builder / field picker）がcontextごとに参照可能なfieldを列挙するためのcontract。
 * namespacesは動的なfield（Node output等）の入口、fieldsは型付きで既知のfield。
 */
export type FieldCatalogView = {
  context: string;
  namespaces: FieldNamespace[];
  fields: FieldDefinition[];
};

export type FieldCatalogIssue = {
  code: "field_not_allowed" | "unsafe_field_path" | "duplicate_field";
  path: string;
  message: string;
};

/** policyの範囲外・unsafe・重複したfieldを拒否して、UIへ返すcatalogを確定する。 */
export function describeFieldCatalog(
  policy: FieldNamespacePolicy,
  fields: FieldCatalog,
): Result.Result<FieldCatalogView, FieldCatalogIssue[]> {
  const issues: FieldCatalogIssue[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (hasUnsafeFieldSegment(field.path)) {
      issues.push({
        code: "unsafe_field_path",
        path: field.path,
        message: `安全でないfield pathです: ${field.path}`,
      });
      continue;
    }
    if (!matchFieldNamespace(policy, field.path)) {
      issues.push({
        code: "field_not_allowed",
        path: field.path,
        message: `${policy.context}から参照できないfield pathです: ${field.path}`,
      });
      continue;
    }
    if (seen.has(field.path)) {
      issues.push({
        code: "duplicate_field",
        path: field.path,
        message: `fieldが重複しています: ${field.path}`,
      });
      continue;
    }
    seen.add(field.path);
  }
  if (issues.length > 0) return Result.fail(issues);
  return Result.succeed({
    context: policy.context,
    namespaces: [...policy.namespaces],
    fields: [...fields],
  });
}

export function findFieldDefinition(
  catalog: FieldCatalog | undefined,
  path: string,
): FieldDefinition | undefined {
  return catalog?.find((field) => field.path === path);
}
