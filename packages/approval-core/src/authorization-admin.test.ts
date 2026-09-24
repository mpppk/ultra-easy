import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  AUTHORIZATION_ACTION_TYPES,
  AUTHORIZATION_ADMIN_RESOURCE,
  authorizationAdminActionRelation,
  isManagedRelationship,
  relationshipTupleKey,
  validateRelationshipUpdateInput,
} from "./authorization-admin.ts";
import type { OrganizationId, ResourceId, ResourceType } from "./domain/brand.ts";

const organizationId = "organization:tenant-a" as OrganizationId;

function codes(value: unknown): string[] {
  const validated = validateRelationshipUpdateInput(value);
  return validated.type === "invalid" ? validated.issues.map((issue) => issue.code) : [];
}

describe("Managed Relationship Catalog validation (AC-M9-004 / AC-M9-005)", () => {
  it("accepts a catalog relationship and canonicalizes whitespace", () => {
    const validated = validateRelationshipUpdateInput({
      operation: "write",
      tuple: { user: " user:auth0|abc ", relation: "can_execute", object: "ticket:T-1" },
    });
    expect(validated).toEqual({
      type: "valid",
      input: {
        operation: "write",
        tuple: { user: "user:auth0|abc", relation: "can_execute", object: "ticket:T-1" },
      },
    });
  });

  it("always rejects authorization_admin viewer/editor/* mutations (bootstrap-only)", () => {
    for (const relation of ["viewer", "editor", "owner"]) {
      expect(
        codes({
          operation: "write",
          tuple: { user: "user:mallory", relation, object: "authorization_admin:root" },
        }),
      ).toContain("admin_relationship_immutable");
    }
    expect(
      isManagedRelationship({ objectType: "authorization_admin", relation: "editor" }, [
        {
          objectType: "authorization_admin",
          relation: "editor",
          subjectTypes: ["user"],
          description: "",
        },
      ]),
    ).toBe(false);
  });

  it("rejects relations outside the catalog", () => {
    expect(
      codes({
        operation: "delete",
        tuple: { user: "user:a", relation: "owner", object: "ticket:T-1" },
      }),
    ).toEqual(["relationship_not_managed"]);
  });

  it("rejects provider-scoped objects (cross-tenant injection) and PII identifiers", () => {
    expect(
      codes({
        operation: "write",
        tuple: {
          user: "user:a",
          relation: "can_execute",
          object: "ticket:organization%3Atenant-b/T-1",
        },
      }),
    ).toContain("provider_scoped_object");
    expect(
      codes({
        operation: "write",
        tuple: { user: "user:alice@example.com", relation: "can_execute", object: "ticket:T-1" },
      }),
    ).toContain("pii_identifier");
    expect(
      codes({
        operation: "write",
        tuple: { user: "team:finance#member", relation: "can_execute", object: "ticket:T-1" },
      }),
    ).toContain("invalid_user");
  });

  it("rejects unknown fields, bad operations and non-object input", () => {
    expect(codes(null)).toEqual(["input_not_object"]);
    expect(
      codes({
        operation: "upsert",
        tuple: { user: "user:a", relation: "can_execute", object: "ticket:T-1" },
        organizationId: "organization:tenant-b",
      }),
    ).toEqual(["unexpected_field", "invalid_operation"]);
  });
});

describe("authorization admin relation mapping", () => {
  it("maps relationship update on authorization_admin:root to editor and fails closed otherwise", () => {
    expect(
      authorizationAdminActionRelation({
        actionType: AUTHORIZATION_ACTION_TYPES.relationshipUpdate,
        resource: AUTHORIZATION_ADMIN_RESOURCE,
      }),
    ).toBe("editor");
    expect(
      authorizationAdminActionRelation({
        actionType: AUTHORIZATION_ACTION_TYPES.relationshipUpdate,
        resource: { type: "ticket" as ResourceType, id: "T-1" as ResourceId },
      }),
    ).toBeNull();
  });
});

describe("relationshipTupleKey", () => {
  it("is deterministic per organization + logical tuple", async () => {
    const tuple = { user: "user:a", relation: "can_execute", object: "ticket:T-1" };
    const [first, second, other] = await Promise.all([
      relationshipTupleKey({ organizationId, tuple }),
      relationshipTupleKey({ organizationId, tuple: { ...tuple } }),
      relationshipTupleKey({ organizationId: "organization:tenant-b" as OrganizationId, tuple }),
    ]);
    assert(Result.isSuccess(first) && Result.isSuccess(second) && Result.isSuccess(other));
    expect(first.value).toBe(second.value);
    expect(first.value).not.toBe(other.value);
    expect(first.value.startsWith("tuple:sha256:")).toBe(true);
  });
});
