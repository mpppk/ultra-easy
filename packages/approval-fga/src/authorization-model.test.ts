import { readFileSync } from "node:fs";

import { transformer } from "@openfga/syntax-transformer";
import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  AUTHORIZATION_MODEL_SOURCE,
  authorizationModelChecksum,
  normalizeAuthorizationModel,
} from "./authorization-model.ts";

const dsl = readFileSync(new URL("../openfga/model.fga", import.meta.url), "utf8");

describe("GitOps authorization model source (AC-M9-008)", () => {
  it("committed JSON matches the DSL source of truth", () => {
    const fromDsl = normalizeAuthorizationModel(transformer.transformDSLToJSONObject(dsl));
    const committed = normalizeAuthorizationModel(AUTHORIZATION_MODEL_SOURCE);
    assert(fromDsl && committed);
    expect(committed).toEqual(fromDsl);
  });

  it("keeps ticket regression relations and adds authorization_admin viewer/editor", () => {
    const normalized = normalizeAuthorizationModel(AUTHORIZATION_MODEL_SOURCE);
    assert(normalized);
    const relations = Object.fromEntries(
      normalized.typeDefinitions.map((definition) => [definition.type, definition.relations]),
    );
    expect(relations).toEqual({
      authorization_admin: ["editor", "viewer"],
      mcp_tool: ["can_use"],
      ticket: ["can_approve", "can_execute"],
      user: [],
    });
  });

  it("normalizes provider responses (ids, null metadata, empty conditions) to the same checksum", async () => {
    const providerShape = {
      id: "01MODEL",
      schema_version: "1.1",
      conditions: {},
      type_definitions: [...AUTHORIZATION_MODEL_SOURCE.type_definitions]
        .reverse()
        .map((definition) => ({
          ...definition,
          metadata: definition.metadata ?? null,
          relations: definition.relations ?? {},
        })),
    };
    const left = normalizeAuthorizationModel(providerShape);
    const right = normalizeAuthorizationModel(AUTHORIZATION_MODEL_SOURCE);
    assert(left && right);
    const [leftChecksum, rightChecksum] = await Promise.all([
      authorizationModelChecksum(left),
      authorizationModelChecksum(right),
    ]);
    assert(Result.isSuccess(leftChecksum) && Result.isSuccess(rightChecksum));
    expect(leftChecksum.value).toBe(rightChecksum.value);
  });

  it("preserves the direct-relation `this: {}` marker (a changed model does not normalize equal)", () => {
    const normalized = normalizeAuthorizationModel(AUTHORIZATION_MODEL_SOURCE);
    const ticket = normalized?.typeDefinitions.find((definition) => definition.type === "ticket");
    expect(ticket?.definition).toMatchObject({ relations: { can_execute: { this: {} } } });

    const narrowed = normalizeAuthorizationModel({
      ...AUTHORIZATION_MODEL_SOURCE,
      type_definitions: AUTHORIZATION_MODEL_SOURCE.type_definitions.map((definition) =>
        definition.type === "authorization_admin"
          ? { ...definition, relations: { ...definition.relations, viewer: { this: {} } } }
          : definition,
      ),
    });
    expect(narrowed).not.toEqual(normalized);
  });
});
