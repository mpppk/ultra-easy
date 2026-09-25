import { isPlainRecord } from "@app/expression-core";

/**
 * Program Node / LLM出力の境界で使う、JSON Schemaの小さな部分集合（serializable）。
 * 外部ライブラリを使わず、pureに検証できる範囲に限定する。
 */
export type JsonSchemaLite =
  | { type: "any" }
  | { type: "null" }
  | { type: "boolean" }
  | { type: "string"; enum?: string[]; maxLength?: number }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "array"; items?: JsonSchemaLite; maxItems?: number }
  | {
      type: "object";
      properties?: Record<string, JsonSchemaLite>;
      required?: string[];
      additionalProperties?: boolean;
    };

export type SchemaIssue = { path: string; message: string };

const MAX_SCHEMA_DEPTH = 16;

function check(
  schema: JsonSchemaLite,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  depth: number,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push({ path, message: "schemaのnestが深すぎます" });
    return;
  }
  switch (schema.type) {
    case "any":
      return;
    case "null":
      if (value !== null) issues.push({ path, message: "nullである必要があります" });
      return;
    case "boolean":
      if (typeof value !== "boolean") issues.push({ path, message: "booleanである必要があります" });
      return;
    case "string":
      if (typeof value !== "string") {
        issues.push({ path, message: "stringである必要があります" });
        return;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        issues.push({ path, message: `${schema.enum.join(" | ")}のいずれかである必要があります` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path, message: `${schema.maxLength}文字以下である必要があります` });
      }
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({ path, message: `${schema.type}である必要があります` });
        return;
      }
      if (schema.type === "integer" && !Number.isSafeInteger(value)) {
        issues.push({ path, message: "整数である必要があります" });
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path, message: `${schema.minimum}以上である必要があります` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path, message: `${schema.maximum}以下である必要があります` });
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        issues.push({ path, message: "arrayである必要があります" });
        return;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({ path, message: `要素数は${schema.maxItems}以下である必要があります` });
      }
      if (schema.items) {
        const itemSchema = schema.items;
        value.forEach((item, index) =>
          check(itemSchema, item, `${path}[${index}]`, issues, depth + 1),
        );
      }
      return;
    case "object": {
      if (!isPlainRecord(value)) {
        issues.push({ path, message: "objectである必要があります" });
        return;
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key))
          issues.push({ path: `${path}.${key}`, message: "必須です" });
      }
      for (const [key, child] of Object.entries(value)) {
        const property = schema.properties?.[key];
        if (property) check(property, child, `${path}.${key}`, issues, depth + 1);
        else if (schema.additionalProperties === false) {
          issues.push({ path: `${path}.${key}`, message: "定義されていないpropertyです" });
        }
      }
      return;
    }
  }
}

export function validateJsonSchemaLite(schema: JsonSchemaLite, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, value, "$", issues, 0);
  return issues;
}
