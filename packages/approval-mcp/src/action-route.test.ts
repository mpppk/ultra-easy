import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ActionDefinitionKey,
  ActionExecutionGuaranteeLevel,
  ActionExecutionRequest,
  ActionFingerprint,
  ActionRequestId,
  ExecutorKey,
} from "@app/approval-core";

import {
  InMemoryMcpActionRouteRepository,
  McpCatalogActionExecutor,
  mcpActionRouteFingerprint,
  mcpCatalogExecutorKey,
  type McpActionRoute,
} from "./action-route.ts";
import { McpDownstreamTransportError, StaticMcpDownstreamServerRegistry } from "./executor.ts";
import { mcpJsonRpcExecutorErrorCode } from "./projection.ts";
import {
  branded,
  FakeDownstream,
  org,
  otherOrg,
  priorityActionType,
  T0,
  ticket,
} from "./test-support.ts";

const key = branded<ActionDefinitionKey>("app:ticket-priority");
const executorKey = branded<ExecutorKey>(mcpCatalogExecutorKey("ticket-server"));

function route(overrides: Partial<McpActionRoute> = {}): McpActionRoute {
  return {
    organizationId: org,
    actionDefinitionKey: key,
    actionDefinitionVersion: 1,
    actionType: priorityActionType,
    target: { mcpServerId: "ticket-server", toolName: "set_priority" },
    argumentMapping: { resourceType: ticket, resourceIdArgument: "ticketId" },
    ...overrides,
  };
}

function request(overrides: Partial<ActionExecutionRequest> = {}): ActionExecutionRequest {
  return {
    organizationId: org,
    actionRequestId: branded<ActionRequestId>("action-request:catalog"),
    actionFingerprint: branded<ActionFingerprint>("sha256:fingerprint"),
    idempotencyKey: "ue:v1:org:action-request:catalog:fingerprint",
    action: {
      definition: {
        key,
        version: 1,
        actionType: priorityActionType,
        inputSchema: { key: branded("ticket-input"), version: 1 },
        executorKey,
      },
      type: priorityActionType,
      resource: { type: ticket, id: branded("T-1") },
      input: { priority: "critical" },
    },
    authorizationEvidence: { evaluatedAt: T0, consistency: "higher_consistency" },
    ...overrides,
  };
}

function harness(
  options: { routes?: McpActionRoute[]; guaranteeLevel?: ActionExecutionGuaranteeLevel } = {},
) {
  const downstream = new FakeDownstream();
  const executor = new McpCatalogActionExecutor({
    serverId: "ticket-server",
    routes: new InMemoryMcpActionRouteRepository(options.routes ?? [route()]),
    serverRegistry: new StaticMcpDownstreamServerRegistry([
      { id: "ticket-server", endpoint: "https://tickets.example/mcp" },
      { id: "other-server", endpoint: "https://other.example/mcp" },
    ]),
    client: downstream,
    ...(options.guaranteeLevel ? { guaranteeLevel: options.guaranteeLevel } : {}),
  });
  return { executor, downstream };
}

describe("McpCatalogActionExecutor", () => {
  it("routes by the snapshotted ActionDefinition version and returns structuredContent", async () => {
    const { executor, downstream } = harness();
    const result = await executor.execute(request());
    assert(Result.isSuccess(result));
    expect(result.value).toEqual({ status: "succeeded", output: { ok: true } });
    expect(downstream.calls).toEqual([
      {
        server: { id: "ticket-server", endpoint: "https://tickets.example/mcp" },
        toolName: "set_priority",
        arguments: { priority: "critical", ticketId: "T-1" },
        idempotencyKey: "ue:v1:org:action-request:catalog:fingerprint",
        actionRequestId: "action-request:catalog",
      },
    ]);
  });

  it("never lets Action input override the resource ID argument", async () => {
    const { executor, downstream } = harness();
    const base = request();
    await executor.execute(
      request({ action: { ...base.action, input: { priority: "low", ticketId: "T-other" } } }),
    );
    expect(downstream.calls[0]?.arguments).toEqual({ priority: "low", ticketId: "T-1" });
  });

  it("fails closed when the definition version has no registered route", async () => {
    const { executor, downstream } = harness();
    const base = request();
    const result = await executor.execute(
      request({
        action: { ...base.action, definition: { ...base.action.definition, version: 2 } },
      }),
    );
    assert(Result.isFailure(result));
    expect(result.error.code).toBe("mcp_action_route_missing");
    expect(result.error.retriable).toBe(false);
    expect(downstream.calls).toHaveLength(0);
  });

  it("does not resolve routes across organizations", async () => {
    const { executor, downstream } = harness({ routes: [route({ organizationId: otherOrg })] });
    const result = await executor.execute(request());
    assert(Result.isFailure(result));
    expect(result.error.code).toBe("mcp_action_route_missing");
    expect(downstream.calls).toHaveLength(0);
  });

  it.each([
    ["action type", route({ actionType: branded("ticket.close") })],
    [
      "resource type",
      route({
        argumentMapping: { resourceType: branded("invoice"), resourceIdArgument: "ticketId" },
      }),
    ],
    [
      "server of another executor",
      route({ target: { mcpServerId: "other-server", toolName: "set_priority" } }),
    ],
  ])("rejects a route whose %s does not match", async (_label, mismatched) => {
    const { executor, downstream } = harness({ routes: [mismatched] });
    const result = await executor.execute(request());
    assert(Result.isFailure(result));
    expect(result.error.code).toBe("mcp_action_route_mismatch");
    expect(downstream.calls).toHaveLength(0);
  });

  it("maps a tool-level error to an execution failure with the downstream code", async () => {
    const { executor, downstream } = harness({ guaranteeLevel: "idempotent" });
    downstream.outcome = Result.succeed({
      type: "result",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "search_index_unavailable: down" }],
        structuredContent: { code: "search_index_unavailable", message: "down", retriable: true },
        isError: true,
      },
    });
    const retriable = await executor.execute(request());
    assert(Result.isFailure(retriable));
    expect(retriable.error.code).toBe("search_index_unavailable");
    expect(retriable.error.retriable).toBe(true);

    const atMostOnce = harness();
    atMostOnce.downstream.outcome = downstream.outcome;
    const notRetried = await atMostOnce.executor.execute(request());
    assert(Result.isFailure(notRetried));
    expect(notRetried.error.retriable).toBe(false);
  });

  it("does not accept an arbitrary error code from the downstream", async () => {
    const { executor, downstream } = harness();
    downstream.outcome = Result.succeed({
      type: "result",
      result: {
        resultType: "complete",
        content: [],
        structuredContent: { code: "Not A Code\n" },
        isError: true,
      },
    });
    const result = await executor.execute(request());
    assert(Result.isFailure(result));
    expect(result.error.code).toBe("mcp_tool_error");
  });

  it("keeps JSON-RPC and transport failure semantics of the Gateway executor", async () => {
    const { executor, downstream } = harness({ guaranteeLevel: "idempotent" });
    downstream.outcome = Result.succeed({
      type: "jsonrpc_error",
      error: { code: -32602, message: "bad params" },
    });
    const jsonrpc = await executor.execute(request());
    assert(Result.isFailure(jsonrpc));
    expect(jsonrpc.error.code).toBe(mcpJsonRpcExecutorErrorCode(-32602));
    expect(jsonrpc.error.retriable).toBe(false);

    downstream.outcome = Result.fail(
      new McpDownstreamTransportError("mcp_downstream_timeout", "ambiguous", false, "timeout"),
    );
    const ambiguous = await executor.execute(request());
    assert(Result.isFailure(ambiguous));
    expect(ambiguous.error.retriable).toBe(true);
  });

  it("treats a missing downstream server as a retriable configuration gap", async () => {
    const executor = new McpCatalogActionExecutor({
      serverId: "ticket-server",
      routes: new InMemoryMcpActionRouteRepository([route()]),
      serverRegistry: new StaticMcpDownstreamServerRegistry([]),
      client: new FakeDownstream(),
    });
    const result = await executor.execute(request());
    assert(Result.isFailure(result));
    expect(result.error.code).toBe("mcp_server_not_configured");
    expect(result.error.retriable).toBe(true);
  });
});

describe("mcpActionRouteFingerprint", () => {
  it("changes when the routing target changes", async () => {
    const original = await mcpActionRouteFingerprint(route());
    const retargeted = await mcpActionRouteFingerprint(
      route({ target: { mcpServerId: "ticket-server", toolName: "set_priority_v2" } }),
    );
    assert(Result.isSuccess(original) && Result.isSuccess(retargeted));
    expect(original.value).not.toBe(retargeted.value);
    expect(original.value).toMatch(/^sha256:/);
  });
});
