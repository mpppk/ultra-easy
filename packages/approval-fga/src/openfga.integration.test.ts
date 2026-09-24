import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  AuthorizationObjectRef,
  OrganizationId,
  RelationName,
  UserId,
} from "@app/approval-core";
import { createHumanActionRequest } from "@app/approval-core/testing";

import {
  AUTHORIZATION_MODEL_SOURCE,
  authorizationModelChecksum,
  normalizeAuthorizationModel,
} from "./authorization-model.ts";
import {
  OpenFgaActionAuthorizer,
  OpenFgaApproverResolver,
  OpenFgaClient,
  OpenFgaOrganizationProjector,
} from "./openfga.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

async function postJson<T extends Record<string, unknown>>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

const openFgaApiUrl = process.env.OPENFGA_TEST_URL;
const describeOpenFga = openFgaApiUrl ? describe : describe.skip;

describeOpenFga("OpenFGA test store/model integration", () => {
  it("実store/modelでWrite・Check・ListUsersを実行できる", async () => {
    assert(openFgaApiUrl);

    const store = await postJson<{ id: string }>(`${openFgaApiUrl}/stores`, {
      name: `ultra-easy-m3-${Date.now()}`,
    });
    const model = await postJson<{ authorization_model_id: string }>(
      `${openFgaApiUrl}/stores/${store.id}/authorization-models`,
      {
        schema_version: "1.1",
        type_definitions: [
          {
            type: "user",
            relations: { manager: { this: {} } },
            metadata: {
              relations: {
                manager: { directly_related_user_types: [{ type: "user" }] },
              },
            },
          },
          {
            type: "ticket",
            relations: { change_priority: { this: {} } },
            metadata: {
              relations: {
                change_priority: { directly_related_user_types: [{ type: "user" }] },
              },
            },
          },
        ],
      },
    );

    const client = new OpenFgaClient({
      apiUrl: openFgaApiUrl,
      storeId: store.id,
      authorizationModelId: model.authorization_model_id,
      organizationId: branded<OrganizationId>("organization:integration"),
      listUsersCompleteness: "assume_complete",
    });
    const projector = new OpenFgaOrganizationProjector(client);
    const projected = await projector.project({
      writes: [
        { user: "user:alice", relation: "change_priority", object: "ticket:TICKET-123" },
        { user: "user:bob", relation: "manager", object: "user:alice" },
      ],
    });
    assert(Result.isSuccess(projected));

    const authorizer = new OpenFgaActionAuthorizer(client, () =>
      branded<RelationName>("change_priority"),
    );
    const authorization = await authorizer.check({
      request: createHumanActionRequest(),
      evaluatedAt: "2026-09-12T12:00:00.000Z",
      consistency: "higher_consistency",
    });
    assert(Result.isSuccess(authorization));
    expect(authorization.value.type).toBe("allow");

    const resolver = new OpenFgaApproverResolver(client);
    const target = {
      type: "relation" as const,
      object: branded<AuthorizationObjectRef>("user:alice"),
      relation: branded<RelationName>("manager"),
      sourceKind: "principal_relation" as const,
    };
    const listed = await resolver.list({ target, consistency: "minimize_latency" });
    assert(Result.isSuccess(listed));
    expect(listed.value).toEqual({ userIds: ["user:bob"], complete: true });

    const checked = await resolver.check({
      target,
      userId: branded<UserId>("user:bob"),
      consistency: "higher_consistency",
    });
    assert(Result.isSuccess(checked));
    expect(checked.value).toBe(true);
  });

  it("GitOps model: authorization_admin viewer/editor, tenant-scoped exact read, model read parity", async () => {
    assert(openFgaApiUrl);
    const store = await postJson<{ id: string }>(`${openFgaApiUrl}/stores`, {
      name: `ultra-easy-m9-${Date.now()}`,
    });
    const model = await postJson<{ authorization_model_id: string }>(
      `${openFgaApiUrl}/stores/${store.id}/authorization-models`,
      AUTHORIZATION_MODEL_SOURCE as unknown as Record<string, unknown>,
    );
    const clientFor = (organizationId: string) =>
      new OpenFgaClient({
        apiUrl: openFgaApiUrl,
        storeId: store.id,
        authorizationModelId: model.authorization_model_id,
        organizationId: branded<OrganizationId>(organizationId),
      });
    const tenantA = clientFor("organization:tenant-a");
    const tenantB = clientFor("organization:tenant-b");

    const written = await tenantA.writeTuples({
      writes: [
        { user: "user:editor", relation: "editor", object: "authorization_admin:root" },
        { user: "user:alice", relation: "can_execute", object: "ticket:T-1" },
      ],
    });
    assert(Result.isSuccess(written));

    const check = (client: OpenFgaClient, user: string, relation: string) =>
      client.check({
        user,
        relation,
        object: "authorization_admin:root",
        consistency: "higher_consistency",
      });
    for (const [client, user, relation, expected] of [
      [tenantA, "user:editor", "viewer", true],
      [tenantA, "user:editor", "editor", true],
      [tenantA, "user:alice", "viewer", false],
      [tenantB, "user:editor", "viewer", false],
    ] as const) {
      const result = await check(client, user, relation);
      assert(Result.isSuccess(result));
      expect(result.value, `${user} ${relation}`).toBe(expected);
    }

    const tuple = { user: "user:alice", relation: "can_execute", object: "ticket:T-1" };
    const presentA = await tenantA.readTuple({ tuple, consistency: "higher_consistency" });
    const presentB = await tenantB.readTuple({ tuple, consistency: "higher_consistency" });
    assert(Result.isSuccess(presentA) && Result.isSuccess(presentB));
    expect([presentA.value, presentB.value]).toEqual([true, false]);

    const deleted = await tenantA.writeTuples({ deletes: [tuple] });
    assert(Result.isSuccess(deleted));
    const absent = await tenantA.readTuple({ tuple, consistency: "higher_consistency" });
    assert(Result.isSuccess(absent));
    expect(absent.value).toBe(false);

    const duplicateDelete = await tenantA.writeTuples({ deletes: [tuple] });
    assert(Result.isFailure(duplicateDelete));
    expect(duplicateDelete.error.status).toBe(400);

    const read = await tenantA.readAuthorizationModel();
    assert(Result.isSuccess(read));
    expect(read.value.id).toBe(model.authorization_model_id);
    const provider = normalizeAuthorizationModel(read.value.model);
    const source = normalizeAuthorizationModel(AUTHORIZATION_MODEL_SOURCE);
    assert(provider && source);
    const [providerChecksum, sourceChecksum] = await Promise.all([
      authorizationModelChecksum(provider),
      authorizationModelChecksum(source),
    ]);
    assert(Result.isSuccess(providerChecksum) && Result.isSuccess(sourceChecksum));
    expect(providerChecksum.value).toBe(sourceChecksum.value);
  });
});
