import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { AuthorizationObjectRef, RelationName, UserId } from "@app/approval-core";
import { createHumanActionRequest } from "@app/approval-core/testing";

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
});
