import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  createPublicPrincipalDirectoryApi,
  HttpTrustedContextError,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import type { OrganizationId, PrincipalRef, UserId } from "@app/approval-core";
import { D1PrincipalDirectoryRepository } from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";

const one = "org:one" as OrganizationId;
const two = "org:two" as OrganizationId;
const alice: PrincipalRef = { type: "user", id: "user:alice" as UserId };
const bob: PrincipalRef = { type: "user", id: "user:bob" as UserId };
const carol: PrincipalRef = { type: "user", id: "user:carol" as UserId };

function harness() {
  const db = migratedSqliteD1();
  const identityProvider: PublicHttpIdentityProvider = {
    authenticate: async ({ request, organizationId, operation }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token)
        return Result.fail(
          new HttpTrustedContextError(401, "authentication_required", "Authentication required"),
        );
      if (token === "machine")
        return Result.succeed({ type: "agent", id: "agent:bot" } as PrincipalRef);
      if (token === "scope-denied" && operation === "principal_directory.ensure")
        return Result.fail(new HttpTrustedContextError(403, "insufficient_scope", "Forbidden"));
      if (token === "alice" && organizationId === one) return Result.succeed(alice);
      if (token === "bob" && organizationId === one) return Result.succeed(bob);
      if (token === "carol" && organizationId === two) return Result.succeed(carol);
      if (token === "scope-denied" && organizationId === one) return Result.succeed(alice);
      return Result.fail(
        new HttpTrustedContextError(403, "organization_membership_required", "Forbidden"),
      );
    },
  };
  return createPublicPrincipalDirectoryApi({
    repository: new D1PrincipalDirectoryRepository(db),
    identityProvider,
    clock: { now: () => "2026-09-30T00:00:00.000Z" },
  });
}

function request(path: string, token: string | null, body?: unknown): Request {
  return new Request(`https://api.example.test${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("public principal directory API (#194)", () => {
  it("registers only the verified user and lists only the caller's organization", async () => {
    const api = harness();
    const putOne = `/v1/organizations/${one}/me/principal`;
    const putTwo = `/v1/organizations/${two}/me/principal`;
    expect(
      (await api.fetch(request(putOne, "alice", { id: alice.id, displayName: " Alice " }))).status,
    ).toBe(200);
    expect(
      (await api.fetch(request(putOne, "bob", { id: bob.id, displayName: "Bob" }))).status,
    ).toBe(200);
    expect(
      (await api.fetch(request(putTwo, "carol", { id: carol.id, displayName: "Carol" }))).status,
    ).toBe(200);
    expect(
      (await api.fetch(request(putOne, "alice", { id: bob.id, displayName: "Spoofed" }))).status,
    ).toBe(403);
    expect(
      (await api.fetch(request(putTwo, "alice", { id: alice.id, displayName: "Alice" }))).status,
    ).toBe(403);

    const listed = await api.fetch(request(`/v1/organizations/${one}/principals`, "alice"));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      items: [
        { id: alice.id, displayName: "Alice" },
        { id: bob.id, displayName: "Bob" },
      ],
    });
    const other = await api.fetch(request(`/v1/organizations/${two}/principals`, "carol"));
    expect(await other.json()).toEqual({ items: [{ id: carol.id, displayName: "Carol" }] });
    expect((await api.fetch(request(`/v1/organizations/${one}/principals`, "carol"))).status).toBe(
      403,
    );
  });

  it("refreshes display names and paginates without duplicating principals", async () => {
    const api = harness();
    const put = `/v1/organizations/${one}/me/principal`;
    await api.fetch(request(put, "alice", { id: alice.id, displayName: "Alice" }));
    await api.fetch(request(put, "bob", { id: bob.id, displayName: "Bob" }));
    expect(
      (await api.fetch(request(put, "alice", { id: alice.id, displayName: "Alicia" }))).status,
    ).toBe(200);
    const path = `/v1/organizations/${one}/principals?limit=1`;
    const first = (await (await api.fetch(request(path, "bob"))).json()) as {
      items: Array<{ id: string; displayName: string }>;
      nextCursor?: string;
    };
    expect(first.items).toEqual([{ id: alice.id, displayName: "Alicia" }]);
    expect(first.nextCursor).toBeDefined();
    const second = (await (
      await api.fetch(
        request(`${path}&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, "bob"),
      )
    ).json()) as {
      items: Array<{ id: string; displayName: string }>;
      nextCursor?: string;
    };
    expect(second.items).toEqual([{ id: bob.id, displayName: "Bob" }]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("rejects machine callers, missing scope, invalid names, and malformed pagination", async () => {
    const api = harness();
    const put = `/v1/organizations/${one}/me/principal`;
    const list = `/v1/organizations/${one}/principals`;
    expect((await api.fetch(request(list, null))).status).toBe(401);
    expect((await api.fetch(request(list, "machine"))).status).toBe(403);
    expect(
      (await api.fetch(request(put, "machine", { id: alice.id, displayName: "Bot" }))).status,
    ).toBe(403);
    expect(
      (await api.fetch(request(put, "scope-denied", { id: alice.id, displayName: "Alice" })))
        .status,
    ).toBe(403);
    expect(
      (await api.fetch(request(put, "alice", { id: alice.id, displayName: "\n" }))).status,
    ).toBe(400);
    expect((await api.fetch(request(`${list}?limit=0`, "alice"))).status).toBe(400);
    expect((await api.fetch(request(`${list}?cursor=not-json`, "alice"))).status).toBe(400);
  });
});
