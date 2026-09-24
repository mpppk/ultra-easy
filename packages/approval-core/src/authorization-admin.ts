import { Result } from "@praha/byethrow";

import type { ActionDefinition } from "./action-definition.ts";
import { sha256CanonicalJson, type CanonicalJsonError } from "./canonical-json.ts";
import type {
  ActionDefinitionKey,
  ActionType,
  ExecutorKey,
  OrganizationId,
  RelationName,
  ResourceId,
  ResourceType,
  SchemaKey,
} from "./domain/brand.ts";
import type { ResourceRef } from "./domain/action.ts";

/**
 * Authorization Administration Console (M9) domain constants.
 *
 * Console authorization is itself enforced by FGA on the tenant-scoped
 * `authorization_admin:root` object. Its `viewer` / `editor` membership is
 * bootstrap-only (IaC / version-controlled) and is never a Managed
 * Relationship, so no console action can widen console privileges.
 */
export const AUTHORIZATION_ADMIN_OBJECT_TYPE = "authorization_admin";
export const AUTHORIZATION_ADMIN_ROOT_ID = "root";
export const AUTHORIZATION_ADMIN_ROOT_OBJECT = `${AUTHORIZATION_ADMIN_OBJECT_TYPE}:${AUTHORIZATION_ADMIN_ROOT_ID}`;

export const AUTHORIZATION_ADMIN_RELATIONS = {
  viewer: "viewer" as RelationName,
  editor: "editor" as RelationName,
} as const;

export type AuthorizationAdminPermission = keyof typeof AUTHORIZATION_ADMIN_RELATIONS;

export const AUTHORIZATION_ADMIN_RESOURCE: ResourceRef = {
  type: AUTHORIZATION_ADMIN_OBJECT_TYPE as ResourceType,
  id: AUTHORIZATION_ADMIN_ROOT_ID as ResourceId,
};

export const AUTHORIZATION_ACTION_TYPES = {
  relationshipUpdate: "authorization.relationship.update" as ActionType,
} as const;

export const AUTHORIZATION_EXECUTOR_KEY = "authorization" as ExecutorKey;

export const AUTHORIZATION_RELATIONSHIP_UPDATE_SCHEMA_KEY =
  "authorization:relationship-update" as SchemaKey;

/**
 * Bootstrap-installed Action Definition for governed relationship mutation.
 * One ActionRequest carries exactly one tuple mutation (v1).
 */
export const AUTHORIZATION_RELATIONSHIP_UPDATE_DEFINITION: ActionDefinition = {
  key: "authorization:relationship-update" as ActionDefinitionKey,
  version: 1,
  actionType: AUTHORIZATION_ACTION_TYPES.relationshipUpdate,
  inputSchema: { key: AUTHORIZATION_RELATIONSHIP_UPDATE_SCHEMA_KEY, version: 1 },
  executorKey: AUTHORIZATION_EXECUTOR_KEY,
};

/**
 * Action → FGA relation for console-governed actions. Returns null for any
 * resource other than the tenant's `authorization_admin:root`, so callers
 * can fail closed instead of checking an unrelated object.
 */
export function authorizationAdminActionRelation(input: {
  actionType: ActionType;
  resource: ResourceRef;
}): RelationName | null {
  if (String(input.actionType) !== String(AUTHORIZATION_ACTION_TYPES.relationshipUpdate)) {
    return null;
  }
  if (
    String(input.resource.type) !== AUTHORIZATION_ADMIN_OBJECT_TYPE ||
    String(input.resource.id) !== AUTHORIZATION_ADMIN_ROOT_ID
  ) {
    return null;
  }
  return AUTHORIZATION_ADMIN_RELATIONS.editor;
}

/** One console-mutable `object type # relation` pair. */
export type ManagedRelationshipCatalogEntry = {
  objectType: string;
  relation: string;
  /** Subject types allowed for the tuple user (v1: concrete users only). */
  subjectTypes: readonly "user"[];
  description: string;
};

export type ManagedRelationshipCatalog = readonly ManagedRelationshipCatalogEntry[];

/**
 * Server-side allow-list of relationships the console may change. Anything
 * outside this list (including every `authorization_admin:*` relation) is
 * rejected before an ActionRequest is created and again in the executor.
 * Update procedure: docs/runbooks/authorization-console.md.
 */
export const DEFAULT_MANAGED_RELATIONSHIP_CATALOG: ManagedRelationshipCatalog = [
  {
    objectType: "ticket",
    relation: "can_execute",
    subjectTypes: ["user"],
    description: "Execute ticket actions (e.g. ticket.update)",
  },
  {
    objectType: "ticket",
    relation: "can_approve",
    subjectTypes: ["user"],
    description: "Approve ticket actions as a relation-based approver",
  },
];

export type RelationshipOperation = "write" | "delete";

/** Logical (tenant-unscoped) relationship tuple. */
export type RelationshipTuple = {
  user: string;
  relation: string;
  object: string;
};

export type AuthorizationRelationshipUpdateInput = {
  operation: RelationshipOperation;
  tuple: RelationshipTuple;
};

export type RelationshipInputIssueCode =
  | "input_not_object"
  | "unexpected_field"
  | "invalid_operation"
  | "invalid_tuple"
  | "invalid_user"
  | "pii_identifier"
  | "invalid_object"
  | "provider_scoped_object"
  | "admin_relationship_immutable"
  | "relationship_not_managed";

export type RelationshipInputIssue = {
  code: RelationshipInputIssueCode;
  path: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TYPED_ID = /^([a-z][a-z0-9_]*):(.+)$/;
const RELATION = /^[a-z][a-z0-9_]*$/;
// Stable identifiers only: printable ASCII without whitespace, no path/scope separators.
const STABLE_ID = /^[\x21-\x7e]+$/;

function issue(
  code: RelationshipInputIssueCode,
  path: string,
  message: string,
): RelationshipInputIssue {
  return { code, path, message };
}

/**
 * Validates and canonicalizes `authorization.relationship.update` input.
 *
 * - Only Managed Relationship Catalog `objectType#relation` pairs pass.
 * - `authorization_admin:*` is always rejected (bootstrap-only membership).
 * - Objects must be logical `type:id`; provider-scoped refs (`org/id`,
 *   percent-encoded) are rejected rather than trusted.
 * - Users must be stable `user:<id>` identifiers; email-like display values
 *   are rejected so PII never becomes a tuple identifier.
 */
export function validateRelationshipUpdateInput(
  value: unknown,
  catalog: ManagedRelationshipCatalog = DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
):
  | { type: "valid"; input: AuthorizationRelationshipUpdateInput }
  | { type: "invalid"; issues: RelationshipInputIssue[] } {
  if (!isRecord(value)) {
    return {
      type: "invalid",
      issues: [issue("input_not_object", "", "inputはobjectである必要があります")],
    };
  }
  const issues: RelationshipInputIssue[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "operation" && key !== "tuple") {
      issues.push(issue("unexpected_field", key, `未知のfieldです: ${key}`));
    }
  }
  const operation = value.operation;
  if (operation !== "write" && operation !== "delete") {
    issues.push(issue("invalid_operation", "operation", "operationはwrite/deleteのいずれかです"));
  }
  const tuple = value.tuple;
  if (!isRecord(tuple)) {
    issues.push(issue("invalid_tuple", "tuple", "tupleはobjectである必要があります"));
    return { type: "invalid", issues };
  }
  for (const key of Object.keys(tuple)) {
    if (key !== "user" && key !== "relation" && key !== "object") {
      issues.push(issue("unexpected_field", `tuple.${key}`, `未知のfieldです: tuple.${key}`));
    }
  }

  const user = typeof tuple.user === "string" ? tuple.user.trim() : "";
  const userMatch = TYPED_ID.exec(user);
  if (!userMatch || userMatch[1] !== "user" || !STABLE_ID.test(userMatch[2] ?? "")) {
    issues.push(
      issue("invalid_user", "tuple.user", "tuple.userはstableな`user:<id>`である必要があります"),
    );
  } else if (user.includes("@")) {
    issues.push(
      issue(
        "pii_identifier",
        "tuple.user",
        "email等の表示用値はidentifierとして使えません。stable UserIdを指定してください",
      ),
    );
  }

  const relation = typeof tuple.relation === "string" ? tuple.relation.trim() : "";
  if (!RELATION.test(relation)) {
    issues.push(issue("invalid_tuple", "tuple.relation", "tuple.relationが不正です"));
  }

  const object = typeof tuple.object === "string" ? tuple.object.trim() : "";
  const objectMatch = TYPED_ID.exec(object);
  const objectType = objectMatch?.[1] ?? "";
  const objectId = objectMatch?.[2] ?? "";
  if (!objectMatch || !STABLE_ID.test(objectId)) {
    issues.push(
      issue(
        "invalid_object",
        "tuple.object",
        "tuple.objectは論理的な`type:id`である必要があります",
      ),
    );
  } else if (objectId.includes("/") || objectId.includes("%")) {
    issues.push(
      issue(
        "provider_scoped_object",
        "tuple.object",
        "provider-scoped objectは受け付けません。organizationを含まない論理refを指定してください",
      ),
    );
  }

  if (objectType === AUTHORIZATION_ADMIN_OBJECT_TYPE) {
    issues.push(
      issue(
        "admin_relationship_immutable",
        "tuple.object",
        "authorization_admin membershipはbootstrap-onlyで、Consoleから変更できません",
      ),
    );
  } else if (
    objectMatch &&
    RELATION.test(relation) &&
    !catalog.some((entry) => entry.objectType === objectType && entry.relation === relation)
  ) {
    issues.push(
      issue(
        "relationship_not_managed",
        "tuple.relation",
        `${objectType}#${relation}はManaged Relationship Catalog外です`,
      ),
    );
  }

  if (issues.length > 0) return { type: "invalid", issues };
  return {
    type: "valid",
    input: {
      operation: operation as RelationshipOperation,
      tuple: { user, relation, object },
    },
  };
}

/**
 * Deterministic per-organization identity of a logical tuple. Two mutations
 * of the same tuple always share a key, which is the unit of revision
 * ordering.
 */
export async function relationshipTupleKey(input: {
  organizationId: OrganizationId;
  tuple: RelationshipTuple;
}): Result.ResultAsync<string, CanonicalJsonError> {
  const digest = await sha256CanonicalJson({
    organizationId: String(input.organizationId),
    user: input.tuple.user,
    relation: input.tuple.relation,
    object: input.tuple.object,
  });
  return Result.isFailure(digest) ? digest : Result.succeed(`tuple:${String(digest.value)}`);
}

export function isManagedRelationship(
  input: { objectType: string; relation: string },
  catalog: ManagedRelationshipCatalog = DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
): boolean {
  return (
    input.objectType !== AUTHORIZATION_ADMIN_OBJECT_TYPE &&
    catalog.some(
      (entry) => entry.objectType === input.objectType && entry.relation === input.relation,
    )
  );
}
