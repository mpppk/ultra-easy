import { Result } from "@praha/byethrow";

import { sha256CanonicalJson, type CanonicalJsonError, type JsonValue } from "@app/approval-core";

/**
 * GitOps source of the OpenFGA authorization model.
 *
 * `openfga/model.fga` is the source of truth and `openfga/store.fga.yaml`
 * holds the model tests run by CI (`fga model test`). The JSON below is
 * the DSL transformed to OpenFGA JSON; a unit test keeps it in lockstep
 * with the DSL. Runtime code only reads this for comparison and display.
 * There is no model write path in any worker.
 */
export const AUTHORIZATION_MODEL_SOURCE_PATH = "packages/approval-fga/openfga/model.fga";
export const AUTHORIZATION_MODEL_TESTS_PATH = "packages/approval-fga/openfga/store.fga.yaml";

export type OpenFgaTypeDefinition = {
  type: string;
  relations?: Record<string, unknown>;
  metadata?: unknown;
};

export type OpenFgaAuthorizationModelJson = {
  schema_version: string;
  type_definitions: OpenFgaTypeDefinition[];
  conditions?: Record<string, unknown>;
};

export const AUTHORIZATION_MODEL_SOURCE: OpenFgaAuthorizationModelJson = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user" },
    {
      type: "ticket",
      relations: {
        can_execute: { this: {} },
        can_approve: { this: {} },
      },
      metadata: {
        relations: {
          can_execute: { directly_related_user_types: [{ type: "user" }] },
          can_approve: { directly_related_user_types: [{ type: "user" }] },
        },
      },
    },
    {
      type: "authorization_admin",
      relations: {
        editor: { this: {} },
        viewer: { union: { child: [{ this: {} }, { computedUserset: { relation: "editor" } }] } },
      },
      metadata: {
        relations: {
          editor: { directly_related_user_types: [{ type: "user" }] },
          viewer: { directly_related_user_types: [{ type: "user" }] },
        },
      },
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/** Optional members that providers/transformers emit as null or {} interchangeably. */
const OPTIONAL_MEMBERS = new Set(["relations", "metadata", "conditions"]);
/** Source-position metadata that differs between DSL transformer and provider. */
const IGNORED_MEMBERS = new Set(["module", "source_info", "file"]);

/**
 * Recursively drops null / "" members, ignored source metadata, and empty
 * optional members. Empty objects that carry meaning (e.g. the `this: {}` direct
 * relation marker) are kept.
 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (!isRecord(value)) return value;
  const pruned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // OpenFGA encodes "unset" as "" (e.g. `computedUserset.object`, `condition`).
    if (child === null || child === undefined || child === "" || IGNORED_MEMBERS.has(key)) {
      continue;
    }
    const next = prune(child);
    if (OPTIONAL_MEMBERS.has(key) && isEmpty(next)) continue;
    pruned[key] = next;
  }
  return pruned;
}

export type NormalizedAuthorizationModel = {
  schemaVersion: string;
  typeDefinitions: Array<{ type: string; relations: string[]; definition: JsonValue }>;
  conditions: string[];
};

/**
 * Provider-independent normalized view of an OpenFGA model. Equal models
 * (Git source vs provider) normalize to the same value regardless of key
 * order, null metadata or provider-only fields (id, source positions).
 */
export function normalizeAuthorizationModel(value: unknown): NormalizedAuthorizationModel | null {
  if (!isRecord(value)) return null;
  const schemaVersion = value.schema_version;
  const typeDefinitions = value.type_definitions;
  if (typeof schemaVersion !== "string" || !Array.isArray(typeDefinitions)) return null;
  const normalized: NormalizedAuthorizationModel["typeDefinitions"] = [];
  for (const definition of typeDefinitions) {
    if (!isRecord(definition) || typeof definition.type !== "string") return null;
    const pruned = prune({
      relations: definition.relations,
      metadata: definition.metadata,
    }) as Record<string, unknown>;
    normalized.push({
      type: definition.type,
      relations: isRecord(definition.relations) ? Object.keys(definition.relations).sort() : [],
      definition: pruned as JsonValue,
    });
  }
  normalized.sort((left, right) => left.type.localeCompare(right.type));
  return {
    schemaVersion,
    typeDefinitions: normalized,
    conditions: isRecord(value.conditions) ? Object.keys(value.conditions).sort() : [],
  };
}

export async function authorizationModelChecksum(
  model: NormalizedAuthorizationModel,
): Result.ResultAsync<string, CanonicalJsonError> {
  const digest = await sha256CanonicalJson(model as unknown as JsonValue);
  return Result.isFailure(digest) ? digest : Result.succeed(String(digest.value));
}
