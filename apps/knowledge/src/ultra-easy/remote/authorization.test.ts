import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { RemoteAuthorizationClient } from "./authorization.ts";

const organizationId = "organization:staging";
const baseUrl = "https://approval-api.internal";

describe("Knowledge remote authorization client (#213)", () => {
  it("uses the session token for paginated principal, role and member reads", async () => {
    const seen: Array<{ path: string; token: string; cursor: string | null }> = [];
    const client = new RemoteAuthorizationClient({
      baseUrl,
      organizationId,
      principalId: "user:alice",
      accessToken: "user-token",
      send: async (request) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        seen.push({
          path: url.pathname,
          token: request.headers.get("authorization") ?? "",
          cursor,
        });
        if (url.pathname.endsWith("/principals"))
          return Response.json(
            cursor
              ? { items: [{ id: "user:bob", displayName: "Bob" }] }
              : {
                  items: [{ id: "user:alice", displayName: "Alice" }],
                  nextCursor: '{"id":"user:alice","displayName":"Alice"}',
                },
          );
        if (url.pathname.endsWith("/space-roles"))
          return Response.json(
            cursor
              ? { items: [{ spaceId: "spc-two", role: "viewer" }] }
              : {
                  items: [{ spaceId: "spc-one", role: "owner" }],
                  nextCursor: '{"object":"knowledge_space:spc-one","relation":"owner"}',
                },
          );
        return Response.json({ items: [{ id: "user:bob", displayName: "Bob", role: "editor" }] });
      },
    });

    const principals = await client.listPrincipals(organizationId);
    expect(principals).toEqual(
      Result.succeed([
        { id: "user:alice", displayName: "Alice" },
        { id: "user:bob", displayName: "Bob" },
      ]),
    );
    const roles = await client.spaceRoles({ organizationId, principalId: "user:alice" });
    expect(roles).toEqual(
      Result.succeed(
        new Map([
          ["spc-one", "owner"],
          ["spc-two", "viewer"],
        ]),
      ),
    );
    const members = await client.spaceMembers({ organizationId, spaceId: "spc-one" });
    expect(members).toEqual(
      Result.succeed([{ principal: { id: "user:bob", displayName: "Bob" }, role: "editor" }]),
    );
    expect(seen).toHaveLength(5);
    expect(seen.every((call) => call.token === "Bearer user-token")).toBe(true);
    expect(seen.filter((call) => call.cursor !== null)).toHaveLength(2);
  });

  it("uses the user token only for self registration and refuses foreign users or tenants locally", async () => {
    const seen: Request[] = [];
    const client = new RemoteAuthorizationClient({
      baseUrl,
      organizationId,
      principalId: "user:alice",
      accessToken: "user-token",
      send: async (request) => {
        seen.push(request);
        return Response.json({ id: "user:alice", displayName: "Alice" });
      },
    });
    const ensured = await client.ensurePrincipal({
      organizationId,
      principal: { id: "user:alice", displayName: "Alice" },
    });
    expect(Result.isSuccess(ensured)).toBe(true);
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer user-token");
    const foreignUser = await client.ensurePrincipal({
      organizationId,
      principal: { id: "user:bob", displayName: "Bob" },
    });
    expect(Result.isFailure(foreignUser) && foreignUser.error.code).toBe("forbidden");
    const foreignRole = await client.spaceRoles({ organizationId, principalId: "user:bob" });
    expect(Result.isFailure(foreignRole) && foreignRole.error.code).toBe("forbidden");
    const foreignTenant = await client.listPrincipals("organization:other");
    expect(Result.isFailure(foreignTenant) && foreignTenant.error.code).toBe("forbidden");
    const foreignGrant = await client.grantSpaceRole({
      organizationId: "organization:other",
      principalId: "user:alice",
      spaceId: "spc-one",
      role: "owner",
    });
    expect(Result.isFailure(foreignGrant) && foreignGrant.error.code).toBe("forbidden");
    expect(seen).toHaveLength(1);
  });

  it("uses the agent token for a governed grant and requires observed FGA confirmation", async () => {
    let confirmed = true;
    const seen: Array<{ token: string; body: unknown; key: string | null }> = [];
    const client = new RemoteAuthorizationClient({
      baseUrl,
      organizationId,
      principalId: "user:alice",
      accessToken: "user-token",
      agentToken: async () => Result.succeed("agent-token"),
      send: async (request) => {
        seen.push({
          token: request.headers.get("authorization") ?? "",
          body: await request.json(),
          key: request.headers.get("idempotency-key"),
        });
        return Response.json({
          status: "executed",
          result: { output: { relationship: { effectConfirmed: confirmed } } },
        });
      },
    });
    const input = {
      organizationId,
      principalId: "user:alice",
      spaceId: "spc-one",
      role: "owner" as const,
    };
    expect(Result.isSuccess(await client.grantSpaceRole(input))).toBe(true);
    expect(seen[0]).toMatchObject({
      token: "Bearer agent-token",
      body: {
        action: {
          type: "application.relationship.update",
          resource: { type: "knowledge_space", id: "spc-one" },
          input: {
            operation: "write",
            tuple: {
              user: "user:alice",
              relation: "owner",
              object: "knowledge_space:spc-one",
            },
          },
        },
      },
    });
    expect(seen[0]?.key).toBeTruthy();
    confirmed = false;
    const pending = await client.grantSpaceRole(input);
    expect(Result.isFailure(pending) && pending.error.code).toBe("invalid_state");
  });

  it("maps denied and malformed upstream responses to typed errors", async () => {
    let response = Response.json({ code: "space_owner_required" }, { status: 403 });
    const client = new RemoteAuthorizationClient({
      baseUrl,
      organizationId,
      principalId: "user:alice",
      accessToken: "user-token",
      send: async () => response,
    });
    const denied = await client.spaceMembers({ organizationId, spaceId: "spc-one" });
    expect(Result.isFailure(denied) && denied.error.code).toBe("forbidden");
    response = Response.json({ items: "unexpected" });
    const malformed = await client.listPrincipals(organizationId);
    expect(Result.isFailure(malformed) && malformed.error.code).toBe("platform_unavailable");
  });
});
