import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { SchemaKey } from "./domain/brand.ts";

/**
 * 永続化可能なSchemaの参照。
 * Schema instance自体はdomain dataへ埋め込まず、keyとversionだけを保持する。
 */
export type SchemaReference = {
  key: SchemaKey;
  version: number;
};

/**
 * SchemaReferenceをStandard Schemaへ解決するPort。
 *
 * approval-coreはZod等の具体的なSchemaライブラリを認識しない。
 */
export interface SchemaResolver {
  resolve(ref: SchemaReference): StandardSchemaV1 | Promise<StandardSchemaV1>;
}

export type SchemaValidationResult<Output> =
  | { type: "valid"; value: Output }
  | { type: "invalid"; issues: ReadonlyArray<StandardSchemaV1.Issue> };

/** Standard Schemaの共通validation contractだけを使ってAction inputを検証する。 */
export async function validateActionInput<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  input: unknown,
): Promise<SchemaValidationResult<Output>> {
  const result = await schema["~standard"].validate(input);

  if (result.issues) {
    return { type: "invalid", issues: result.issues };
  }

  return { type: "valid", value: result.value };
}
