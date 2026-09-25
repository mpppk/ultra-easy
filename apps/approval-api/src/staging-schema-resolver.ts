import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  AUTHORIZATION_RELATIONSHIP_UPDATE_SCHEMA_KEY,
  relationshipUpdateInputSchema,
  type SchemaReference,
  type SchemaResolver,
  type SchemaResolverError,
} from "@app/approval-core";

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

const SCHEMA_KEYS = ["staging:ticket-update"] as const;

/**
 * Staging用の最小SchemaResolver。既知のstaging schema keyのみ解決する。
 * 未知keyはnull（Action Definitionの設定不備）として返す。本番schema catalogはfollow-up。
 */
export class StagingSchemaResolver implements SchemaResolver {
  async resolve(
    ref: SchemaReference,
  ): Result.ResultAsync<StandardSchemaV1 | null, SchemaResolverError> {
    const key = String(ref.key);
    if (key === "staging:ticket-update") return Result.succeed(stagingTicketUpdateSchema());
    if (key === String(AUTHORIZATION_RELATIONSHIP_UPDATE_SCHEMA_KEY)) {
      return Result.succeed(relationshipUpdateInputSchema() as StandardSchemaV1);
    }
    return Result.succeed(null);
  }
}

export function stagingTicketInputSchemaKey(): string {
  return SCHEMA_KEYS[0];
}
