import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { MemoryTelemetrySink } from "@app/approval-core";
import type {
  ActionRequestId,
  AuthorizationObjectRef,
  OrganizationId,
  RelationName,
  ResolvedApproverTarget,
  UserId,
} from "@app/approval-core";
import { createHumanActionRequest } from "@app/approval-core/testing";

import {
  OpenFgaActionAuthorizer,
  OpenFgaApproverResolver,
  OpenFgaClient,
  OpenFgaOrganizationProjector,
  OpenFgaRequestError,
  openFgaFailureEffect,
} from "./openfga.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(requests: Array<{ url: string; init?: RequestInit }>, index = 0) {
  const body = requests[index]?.init?.body;
  assert(typeof body === "string");
  return JSON.parse(body) as Record<string, unknown>;
}

function responseFetch(
  body: unknown,
  requests: Array<{ url: string; init?: RequestInit }>,
): typeof globalThis.fetch {
  return async (input, init) => {
    requests.push({ url: requestUrl(input), ...(init ? { init } : {}) });
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

const organizationId = branded<OrganizationId>("organization:tenant-a");
const otherOrganizationId = branded<OrganizationId>("organization:tenant-b");
const telemetryActionRequestId = branded<ActionRequestId>("action:fga-telemetry");

describe("OpenFGA adapters", () => {
  it("ActionAuthorizerはAction relationをCheckしconsistencyを伝播する", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      fetch: responseFetch({ allowed: true }, requests),
    });
    const authorizer = new OpenFgaActionAuthorizer(client, () =>
      branded<RelationName>("change_priority"),
    );
    const result = await authorizer.check({
      request: createHumanActionRequest(),
      evaluatedAt: "2026-09-12T12:00:00.000Z",
      consistency: "higher_consistency",
    });

    assert(Result.isSuccess(result));
    expect(result.value.type).toBe("allow");
    expect(requests[0]?.url).toBe("https://fga.example/stores/store-1/check");
    expect(requestBody(requests)).toMatchObject({
      authorization_model_id: "model-1",
      tuple_key: {
        user: "user:alice",
        relation: "change_priority",
        object: "ticket:organization%3Atenant-a/TICKET-123",
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
        organizationId,
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
        organizationId,
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
        organizationId,
        fetch: responseFetch({ allowed: true }, requests),
      }),
    );
    const result = await resolver.check({
      target: relationTarget(),
      userId: branded<UserId>("user:bob"),
      consistency: "higher_consistency",
    });

    assert(Result.isSuccess(result));
    expect(result.value).toBe(true);
    expect(requestBody(requests)).toMatchObject({
      tuple_key: {
        user: "user:bob",
        relation: "manager",
        object: "user:organization%3Atenant-a/alice",
      },
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
        organizationId,
        fetch: responseFetch({}, requests),
      }),
    );
    const result = await projector.project({
      writes: [{ user: "user:bob", relation: "manager", object: "org_unit:sales" }],
    });

    assert(Result.isSuccess(result));
    expect(requests[0]?.url).toBe("https://fga.example/stores/store-1/write");
    expect(requestBody(requests)).toMatchObject({
      authorization_model_id: "model-1",
      writes: {
        tuple_keys: [
          {
            user: "user:bob",
            relation: "manager",
            object: "org_unit:organization%3Atenant-a/sales",
          },
        ],
      },
    });
  });

  it("shared storeでは同じresource idをorganizationごとに別objectへnamespaceする", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = responseFetch({ allowed: true }, requests);
    const tenantA = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "shared-store",
      authorizationModelId: "model-1",
      organizationId,
      fetch,
    });
    const tenantB = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "shared-store",
      authorizationModelId: "model-1",
      organizationId: otherOrganizationId,
      fetch,
    });
    await tenantA.check({
      user: "user:alice",
      relation: "viewer",
      object: "ticket:TICKET-1",
      consistency: "higher_consistency",
    });
    await tenantB.check({
      user: "user:alice",
      relation: "viewer",
      object: "ticket:TICKET-1",
      consistency: "higher_consistency",
    });
    expect(requestBody(requests, 0)).toMatchObject({
      tuple_key: { object: "ticket:organization%3Atenant-a/TICKET-1" },
    });
    expect(requestBody(requests, 1)).toMatchObject({
      tuple_key: { object: "ticket:organization%3Atenant-b/TICKET-1" },
    });
  });

  it("AC-M7-007/008: Check/ListUsers latencyとerrorをActionRequest correlation付きで計測する", async () => {
    const telemetry = new MemoryTelemetrySink();
    const client = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      actionRequestId: telemetryActionRequestId,
      telemetry,
      listUsersCompleteness: "assume_complete",
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/list-users")) {
          return new Response(
            JSON.stringify({ users: [{ object: { type: "user", id: "bob" } }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ allowed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const checked = await client.check({
      user: "user:alice",
      relation: "viewer",
      object: "ticket:TICKET-1",
      consistency: "higher_consistency",
    });
    const listed = await client.listUsers({
      object: branded<AuthorizationObjectRef>("ticket:TICKET-1"),
      relation: branded<RelationName>("viewer"),
      consistency: "higher_consistency",
    });
    assert(Result.isSuccess(checked));
    assert(Result.isSuccess(listed));

    expect(telemetry.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "metric",
          name: "fga.check_latency_ms",
          correlation: expect.objectContaining({
            correlationId: String(telemetryActionRequestId),
            component: "fga",
            operation: "check",
          }),
        }),
        expect.objectContaining({
          kind: "metric",
          name: "fga.list_users_latency_ms",
          correlation: expect.objectContaining({
            correlationId: String(telemetryActionRequestId),
            component: "fga",
            operation: "list_users",
          }),
        }),
      ]),
    );

    const errorTelemetry = new MemoryTelemetrySink();
    const failing = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      actionRequestId: telemetryActionRequestId,
      telemetry: errorTelemetry,
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    const failed = await failing.check({
      user: "user:alice",
      relation: "viewer",
      object: "ticket:TICKET-1",
      consistency: "higher_consistency",
    });
    assert(Result.isFailure(failed));
    expect(errorTelemetry.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "metric",
          name: "fga.error_total",
          value: 1,
          correlation: expect.objectContaining({
            correlationId: String(telemetryActionRequestId),
            component: "fga",
          }),
          attributes: { errorCode: "http_error" },
        }),
      ]),
    );
  });

  it("readTupleはtenant-scoped exact tupleをReadし、他tenantの同名tupleを存在扱いしない", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const telemetry = new MemoryTelemetrySink();
    const client = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      telemetry,
      fetch: responseFetch(
        {
          tuples: [
            {
              key: {
                user: "user:alice",
                relation: "can_execute",
                object: "ticket:organization%3Atenant-b/T-1",
              },
            },
          ],
        },
        requests,
      ),
    });
    const tuple = { user: "user:alice", relation: "can_execute", object: "ticket:T-1" };
    const read = await client.readTuple({ tuple, consistency: "higher_consistency" });
    assert(Result.isSuccess(read));
    expect(read.value).toBe(false);
    expect(requests[0]?.url).toBe("https://fga.example/stores/store-1/read");
    expect(requestBody(requests)).toEqual({
      tuple_key: {
        user: "user:alice",
        relation: "can_execute",
        object: "ticket:organization%3Atenant-a/T-1",
      },
      page_size: 1,
      consistency: "HIGHER_CONSISTENCY",
    });
    expect(telemetry.records).toEqual([
      expect.objectContaining({ kind: "metric", name: "fga.read_latency_ms" }),
    ]);

    const present = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      fetch: responseFetch(
        {
          tuples: [
            {
              key: {
                user: "user:alice",
                relation: "can_execute",
                object: "ticket:organization%3Atenant-a/T-1",
              },
            },
          ],
        },
        [],
      ),
    });
    const found = await present.readTuple({ tuple, consistency: "minimize_latency" });
    assert(Result.isSuccess(found));
    expect(found.value).toBe(true);
  });

  it("readAuthorizationModelは固定model IDをGETし、providerSummaryはsecretを含まない", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new OpenFgaClient({
      apiUrl: "https://fga.example/",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      token: "secret-token",
      fetch: responseFetch(
        { authorization_model: { id: "model-1", schema_version: "1.1", type_definitions: [] } },
        requests,
      ),
    });
    const model = await client.readAuthorizationModel();
    assert(Result.isSuccess(model));
    expect(model.value.id).toBe("model-1");
    expect(requests[0]?.url).toBe(
      "https://fga.example/stores/store-1/authorization-models/model-1",
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(client.providerSummary).toEqual({
      apiHost: "fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
    });
    expect(JSON.stringify(client.providerSummary)).not.toContain("secret-token");
    expect(client.providerObject("authorization_admin:root")).toBe(
      "authorization_admin:organization%3Atenant-a/root",
    );
  });

  it("provider失敗をnot_sent / rejected / ambiguousへ分類する", () => {
    const error = (code: string, status?: number) =>
      new OpenFgaRequestError({
        code,
        detail: code,
        retriable: true,
        ...(status === undefined ? {} : { status }),
      });
    expect(openFgaFailureEffect(error("network_error"))).toBe("ambiguous");
    expect(openFgaFailureEffect(error("http_error", 503))).toBe("ambiguous");
    expect(openFgaFailureEffect(error("http_error", 429))).toBe("rejected");
    expect(openFgaFailureEffect(error("http_error", 400))).toBe("rejected");
    expect(openFgaFailureEffect(error("fga_token_exchange_failed"))).toBe("not_sent");
  });

  it("writeTuplesはwrite latency / errorをemitする", async () => {
    const telemetry = new MemoryTelemetrySink();
    const client = new OpenFgaClient({
      apiUrl: "https://fga.example",
      storeId: "store-1",
      authorizationModelId: "model-1",
      organizationId,
      actionRequestId: telemetryActionRequestId,
      telemetry,
      fetch: async () => new Response("bad", { status: 400 }),
    });
    const written = await client.writeTuples({
      writes: [{ user: "user:alice", relation: "can_execute", object: "ticket:T-1" }],
    });
    assert(Result.isFailure(written));
    expect(openFgaFailureEffect(written.error)).toBe("rejected");
    expect(telemetry.records.map((record) => record.kind === "metric" && record.name)).toEqual([
      "fga.write_latency_ms",
      "fga.error_total",
    ]);
  });
});
