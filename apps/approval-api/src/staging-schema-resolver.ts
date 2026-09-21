import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { SchemaReference, SchemaResolver } from "@app/approval-core";

function stagingTicketUpdateSchema(): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "ultra-easy-staging",
      validate(value: unknown) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return { issues: [{ message: "inputはobjectである必要があります" }] };
        }
        const ticketId = (value as Record<string, unknown>).ticketId;
        if (typeof ticketId !== "string" || ticketId.length === 0) {
          return { issues: [{ message: "input.ticketIdは空でない文字列である必要があります" }] };
        }
        return { value: { ticketId } };
      },
    },
  };
}

function unknownSchema(key: string): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "ultra-easy-staging",
      validate(_value: unknown) {
        return { issues: [{ message: `未知のstaging schemaです: ${key}` }] };
      },
    },
  };
}

const SCHEMA_KEYS = ["staging:ticket-update"] as const;

/**
 * Staging用の最小SchemaResolver。既知のstaging schema keyのみ検証を通す。
 * 未知keyはthrowせずvalidation issueとして落とす。本番schema catalogはfollow-up。
 */
export class StagingSchemaResolver implements SchemaResolver {
  resolve(ref: SchemaReference): StandardSchemaV1 | Promise<StandardSchemaV1> {
    const key = String(ref.key);
    if (key === "staging:ticket-update") return stagingTicketUpdateSchema();
    return unknownSchema(key);
  }
}

export function stagingTicketInputSchemaKey(): string {
  return SCHEMA_KEYS[0];
}
