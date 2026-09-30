import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  createPublicApplicationRelationshipApi,
  HttpTrustedContextError,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import type { OrganizationId, PrincipalRef, UserId } from "@app/approval-core";
import { D1ApplicationRelationshipReadRepository } from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";

const one = "organization:one" as OrganizationId;
const two = "organization:two" as OrganizationId;
const alice: PrincipalRef = { type: "user", id: "user:alice" as UserId };
const bob: PrincipalRef = { type: "user", id: "user:bob" as UserId };
const agent: PrincipalRef = { type: "agent", id: "agent:knowledge" as never };

function harness() {
  const db = migratedSqliteD1();
  const identityProvider: PublicHttpIdentityProvider = {
    authenticate: async ({ request, organizationId }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token)
        return Result.fail(new HttpTrustedContextError(401, "authentication_required", "Missing"));
      if (token === "denied")
        return Result.fail(new HttpTrustedContextError(403, "insufficient_scope", "Missing scope"));
      if (organizationId !== one)
        return Result.fail(
          new HttpTrustedContextError(403, "organization_membership_required", "Other org"),
        );
      if (token === "alice") return Result.succeed(alice);
      if (token === "bob") return Result.succeed(bob);
      if (token === "agent") return Result.succeed(agent);
      return Result.fail(new HttpTrustedContextError(403, "client_not_registered", "Unknown"));
    },
  };
  const api = createPublicApplicationRelationshipApi({
    repository: new D1ApplicationRelationshipReadRepository(db),
    identityProvider,
    accessChecker: {
      canManage: async ({ userId, spaceId }) =>
        Result.succeed(userId === alice.id && spaceId === "spc-one"),
    },
    applicationAgentId: String(agent.id),
  });
  const seed = (
    organizationId: OrganizationId,
    subject: string,
    relation: string,
    spaceId: string,
  ) => {
    const object = `knowledge_space:${spaceId}`;
    db.db
      .prepare(
        `INSERT INTO authorization_relationships
           (organization_id, tuple_key, subject, relation, logical_object, object_type,
            desired_present, revision, latest_mutation_key, latest_action_request_id,
            confirmed_revision, confirmed_present, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'knowledge_space', 1, 1, 'mutation:seed', 'action:seed',
                 1, 1, 'confirmed', '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z')`,
      )
      .run(String(organizationId), `${subject}|${relation}|${object}`, subject, relation, object);
  };
  const display = (organizationId: OrganizationId, id: string, name: string) => {
    db.db
      .prepare(
        `INSERT INTO principal_directory
           (organization_id, principal_id, principal_type, display_name, created_at, updated_at)
         VALUES (?, ?, 'user', ?, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z')`,
      )
      .run(String(organizationId), id, name);
  };
  return { api, seed, display };
}

function request(path: string, token: string): Request {
  return new Request(`https://api.example.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("application relationship read API (#195)", () => {
  it("lists the caller's own roles and never exposes another tenant", async () => {
    const { api, seed } = harness();
    seed(one, String(alice.id), "owner", "spc-one");
    seed(one, String(alice.id), "viewer", "spc-one");
    seed(one, String(alice.id), "editor", "spc-two");
    seed(one, String(bob.id), "viewer", "spc-three");
    seed(two, String(alice.id), "owner", "spc-secret");
    const first = (await (
      await api.fetch(request(`/v1/organizations/${one}/me/space-roles?limit=1`, "alice"))
    ).json()) as {
      items: unknown[];
      nextCursor: string;
    };
    expect(first.items).toEqual([{ spaceId: "spc-one", role: "owner" }]);
    const second = await api.fetch(
      request(
        `/v1/organizations/${one}/me/space-roles?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        "alice",
      ),
    );
    expect(await second.json()).toEqual({ items: [{ spaceId: "spc-two", role: "editor" }] });
    expect(
      (await api.fetch(request(`/v1/organizations/${two}/me/space-roles`, "alice"))).status,
    ).toBe(403);
    expect(
      await (await api.fetch(request(`/v1/organizations/${one}/me/space-roles`, "bob"))).json(),
    ).toEqual({
      items: [{ spaceId: "spc-three", role: "viewer" }],
    });
  });

  it("requires space owner or the registered agent for member display", async () => {
    const { api, seed, display } = harness();
    seed(one, String(alice.id), "owner", "spc-one");
    seed(one, String(bob.id), "viewer", "spc-one");
    seed(one, String(bob.id), "editor", "spc-one");
    seed(two, "user:mallory", "owner", "spc-one");
    display(one, String(alice.id), "Alice");
    display(one, String(bob.id), "Bob");
    const path = `/v1/organizations/${one}/spaces/spc-one/members`;
    expect(await (await api.fetch(request(path, "alice"))).json()).toEqual({
      items: [
        { id: alice.id, displayName: "Alice", role: "owner" },
        { id: bob.id, displayName: "Bob", role: "editor" },
      ],
    });
    expect((await api.fetch(request(path, "bob"))).status).toBe(403);
    expect((await api.fetch(request(path, "agent"))).status).toBe(200);
    expect((await api.fetch(request(path, "denied"))).status).toBe(403);
    expect((await api.fetch(request(`${path}?cursor=bad-json`, "alice"))).status).toBe(400);
  });
});
