import { Result } from "@praha/byethrow";
import { assert, beforeEach, describe, expect, it } from "vite-plus/test";

import type {
  ActionDefinitionKey,
  ActionType,
  OrganizationId,
  ResourceType,
} from "@app/approval-core";
import { mcpActionRouteFingerprint, type McpActionRoute } from "@app/approval-mcp";

import { D1McpActionRouteRepository } from "./mcp-action-route-repository.ts";
import { migratedSqliteD1, type SqliteD1Database } from "./testing/sqlite-d1.ts";

const org = "organization:tenant-a" as OrganizationId;
const route: McpActionRoute = {
  organizationId: org,
  actionDefinitionKey: "app:ticket-close" as ActionDefinitionKey,
  actionDefinitionVersion: 1,
  actionType: "ticket.close" as ActionType,
  target: { mcpServerId: "tickets", toolName: "ticket.close" },
  argumentMapping: { resourceType: "ticket" as ResourceType, resourceIdArgument: "ticketId" },
};

async function insert(db: SqliteD1Database, value: McpActionRoute, fingerprint?: string) {
  const computed = await mcpActionRouteFingerprint(value);
  assert(Result.isSuccess(computed));
  db.db
    .prepare(
      `INSERT INTO mcp_action_routes (organization_id, action_definition_key,
         action_definition_version, action_type, route_json, route_fingerprint, source, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, 'test', '2026-09-30T00:00:00.000Z')`,
    )
    .run(
      String(value.organizationId),
      String(value.actionDefinitionKey),
      value.actionDefinitionVersion,
      String(value.actionType),
      JSON.stringify(value),
      fingerprint ?? computed.value,
    );
}

describe("D1McpActionRouteRepository", () => {
  let db: SqliteD1Database;
  let repository: D1McpActionRouteRepository;

  beforeEach(() => {
    db = migratedSqliteD1();
    repository = new D1McpActionRouteRepository(db);
  });

  it("loads the route registered for the exact definition version", async () => {
    await insert(db, route);
    const loaded = await repository.load(route);
    assert(Result.isSuccess(loaded));
    expect(loaded.value).toEqual(route);

    const otherVersion = await repository.load({ ...route, actionDefinitionVersion: 2 });
    assert(Result.isSuccess(otherVersion));
    expect(otherVersion.value).toBeNull();

    const otherOrg = await repository.load({
      ...route,
      organizationId: "organization:tenant-b" as OrganizationId,
    });
    assert(Result.isSuccess(otherOrg));
    expect(otherOrg.value).toBeNull();
  });

  it("keeps registered routes immutable and unique per definition version", async () => {
    await insert(db, route);
    expect(() =>
      db.db.exec(
        "UPDATE mcp_action_routes SET route_json = '{}' WHERE action_definition_key = 'app:ticket-close'",
      ),
    ).toThrow(/immutable/);
    expect(() => db.db.exec("DELETE FROM mcp_action_routes")).toThrow(/immutable/);
    await expect(
      insert(db, { ...route, target: { mcpServerId: "tickets", toolName: "ticket.delete" } }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuses a row whose content no longer matches its fingerprint", async () => {
    const other = await mcpActionRouteFingerprint({
      ...route,
      target: { mcpServerId: "tickets", toolName: "ticket.delete" },
    });
    assert(Result.isSuccess(other));
    await insert(db, route, other.value);
    const loaded = await repository.load(route);
    assert(Result.isFailure(loaded));
    expect(loaded.error.code).toBe("mcp_action_route_corrupted");
    expect(loaded.error.retriable).toBe(false);
  });
});
