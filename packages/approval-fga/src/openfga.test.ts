import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ActionType,
  AuthorizationObjectRef,
  RelationName,
  ResolvedApproverTarget,
} from "@app/approval-core";
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

function responseFetch(
  body: unknown,
  requests: Array<{ url: string; init?: RequestInit }>,
): typeof globalThis.fetch {
  return async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function relationTarget(): ResolvedApproverTarget {
  return {
    type: "relation",
    object: branded<AuthorizationObjectRef>("user:alice"),
    relation: branded<RelationName>("manager"),
    sourceKind: "principal_relation",
  };
}

describe("OpenFGA adapters", () => {
  it("ActionAuthorizerはAction relationをCheckしconsistencyを伝播する", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      fetch: responseFetch({ allowed: true }, requests),
    });
    const authorizer = new OpenFgaActionAuthorizer(
      client,
      (_actionType: ActionType) => branded<RelationName>("change_priority"),
    );
    const result = await authorizer.check({
      request: createHumanActionRequest(),
      evaluatedAt: "2026-09-12T12:00:00.000Z",
      consistency: "higher_consistency",
    });

    assert(Result.isSuccess(result));
    expect(result.value.type).toBe("allow");
    expect(requests[0]?.url).toBe("https://fga.example/stores/store-1/check");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      authorization_model_id: "model-1",
      tuple_key: {
        user: "user:alice",
        relation: "change_priority",
        object: "ticket:TICKET-123",
      },
      consistency: "HIGHER_CONSISTENCY",
    });
  });

  it("ListUsersは既定で完全性を主張せず、明示保証時のみcomplete=trueにする", async () => {
    const body = { users: [{ object: { type: "user", id: "bob" } }] };
    const target = relationTarget();

    const conservative = new OpenFgaApproverResolver(
      new OpenFgaClient({
        apiUrl: "https://fga.example",
        storeId: "store-1",
        authorizationModelId: "model-1",
        fetch: responseFetch(body, []),
      }),
    );
    const conservativeResult = await conservative.list({
      target,
      consistency: "minimize_latency",
    });
    assert(Result.isSuccess(conservativeResult));
    expect(conservativeResult.value).toEqual({ userIds: ["user:bob"], complete: false });

    const complete = new OpenFgaApproverResolver(
      new OpenFgaClient({
        apiUrl: "https://fga.example",
        storeId: "store-1",
        authorizationModelId: "model-1",
        fetch: responseFetch(body, []),
        listUsersCompleteness: "assume_complete",
      }),
    );
    const completeResult = await complete.list({ target, consistency: "minimize_latency" });
    assert(Result.isSuccess(completeResult));
    expect(completeResult.value).toEqual({ userIds: ["user:bob"], complete: true });
  });

  it("ApproverResolver.checkはrelation targetをOpenFGA Checkへ変換する", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const resolver = new OpenFgaApproverResolver(
      new OpenFgaClient({
        apiUrl: "https://fga.example/",
        storeId: "store-1",
        authorizationModelId: "model-1",
        fetch: responseFetch({ allowed: true }, requests),
      }),
    );
    const result = await resolver.check({
      target: relationTarget(),
      userId: branded("user:bob"),
      consistency: "higher_consistency",
    });

    assert(Result.isSuccess(result));
    expect(result.value).toBe(true);
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      tuple_key: { user: "user:bob", relation: "manager", object: "user:alice" },
      consistency: "HIGHER_CONSISTENCY",
    });
  });

  it("Organization projectorはtuple writeをFGAへ投影する", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const projector = new OpenFgaOrganizationProjector(
      new OpenFgaClient({
        apiUrl: "https://fga.example",
        storeId: "store-1",
        authorizationModelId: "model-1",
        fetch: responseFetch({}, requests),
      }),
    );
    const result = await projector.project({
      writes: [{ user: "user:bob", relation: "manager", object: "org_unit:sales" }],
    });

    assert(Result.isSuccess(result));
    expect(requests[0]?.url).toBe("https://fga.example/stores/store-1/write");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      authorization_model_id: "model-1",
      writes: {
        tuple_keys: [{ user: "user:bob", relation: "manager", object: "org_unit:sales" }],
      },
    });
  });
});
