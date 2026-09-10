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
