import type { SchemaKey } from "./domain/brand.ts";
import type { SchemaReference, SchemaResolver } from "./schema.ts";

const schemaKey = "ticket-priority-input" as SchemaKey;

export const schemaReference = {
  key: schemaKey,
  version: 1,
} satisfies SchemaReference;

declare const resolver: SchemaResolver;

export const resolvedSchema = resolver.resolve(schemaReference);

const plainString = "ticket-priority-input";

// @ts-expect-error validation前のplain stringをSchemaKeyとして扱ってはならない
export const invalidSchemaKey: SchemaKey = plainString;
