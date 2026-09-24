import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { MemoryTelemetrySink } from "@app/approval-core";
import type {
  ActionExecutionGuaranteeLevel,
  ActionExecutionRequest,
  ActionFingerprint,
  ActionRequestId,
} from "@app/approval-core";

import { StreamableHttpMcpDownstreamClient, type FetchLike } from "./downstream-http.ts";
import {
  McpActionExecutor,
  McpDownstreamTransportError,
  StaticMcpDownstreamServerRegistry,
  type McpDownstreamFailureEffect,
} from "./executor.ts";
import type { McpRouteSnapshot } from "./invocation.ts";
import { InMemoryMcpRouteSnapshotRepository } from "./memory.ts";
import { MCP_CALL_TOOL_OUTPUT_KIND, mcpJsonRpcExecutorErrorCode } from "./projection.ts";
import { MCP_EXECUTION_IDEMPOTENCY_KEY_META_KEY, MCP_PROTOCOL_REVISION } from "./protocol.ts";
import {
  branded,
  FakeDownstream,
  MCP_EXECUTOR_KEY,
  org,
  priorityActionType,
  T0,
  ticket,
} from "./test-support.ts";

const actionRequestId = branded<ActionRequestId>("action-request:exec");
const fingerprint = branded<ActionFingerprint>("sha256:fingerprint");

function snapshot(overrides: Partial<McpRouteSnapshot> = {}): McpRouteSnapshot {
  return {
    organizationId: org,
    actionRequestId,
    actionFingerprint: fingerprint,
    actionType: priorityActionType,
    bindingId: "binding:ticket-priority",
    bindingVersion: 1,
    bindingFingerprint: "sha256:binding-v1",
    exposedToolName: "ticket_set_priority",
    target: { mcpServerId: "ticket-server", toolName: "set_priority" },
    argumentMapping: { resourceType: ticket, resourceIdArgument: "ticketId" },
    createdAt: T0,
    ...overrides,
  };
}

function request(overrides: Partial<ActionExecutionRequest> = {}): ActionExecutionRequest {
  return {
    organizationId: org,
    actionRequestId,
    actionFingerprint: fingerprint,
    idempotencyKey: "ue:v1:org:action-request:exec:fingerprint",
    action: {
      definition: {
        key: branded("definition:priority"),
        version: 1,
        actionType: priorityActionType,
        inputSchema: { key: branded("ticket-input"), version: 1 },
        executorKey: MCP_EXECUTOR_KEY,
      },
      type: priorityActionType,
      resource: { type: ticket, id: branded("T-1") },
      input: { priority: "critical" },
    },
    authorizationEvidence: { evaluatedAt: T0, consistency: "higher_consistency" },
    ...overrides,
  };
}

async function executorHarness(
  options: { guaranteeLevel?: ActionExecutionGuaranteeLevel; route?: McpRouteSnapshot | null } = {},
) {
  const routes = new InMemoryMcpRouteSnapshotRepository();
  if (options.route !== null) await routes.save(options.route ?? snapshot());
  const downstream = new FakeDownstream();
  const telemetry = new MemoryTelemetrySink();
  const executor = new McpActionExecutor({
    routeSnapshotRepository: routes,
    serverRegistry: new StaticMcpDownstreamServerRegistry([
      { id: "ticket-server", endpoint: "https://tickets.example/mcp" },
      { id: "ticket-server-v2", endpoint: "https://tickets-v2.example/mcp" },
    ]),
    client: downstream,
    telemetry,
    ...(options.guaranteeLevel ? { guaranteeLevel: options.guaranteeLevel } : {}),
  });
  return { executor, downstream, telemetry, routes };
}

describe("MCP Gateway 4: downstream MCP ActionExecutor", () => {
  it("route snapshotのtargetへresource IDとinputを写像しidempotency keyを渡す", async () => {
    const h = await executorHarness();

    const executed = await h.executor.execute(request());

    assert(Result.isSuccess(executed));
    expect(h.downstream.calls).toEqual([
      {
        server: { id: "ticket-server", endpoint: "https://tickets.example/mcp" },
        toolName: "set_priority",
        arguments: { priority: "critical", ticketId: "T-1" },
        idempotencyKey: "ue:v1:org:action-request:exec:fingerprint",
        actionRequestId: "action-request:exec",
      },
    ]);
    expect(executed.value).toEqual({
      status: "succeeded",
      output: {
        kind: MCP_CALL_TOOL_OUTPUT_KIND,
        mcpServerId: "ticket-server",
        toolName: "set_priority",
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "priority updated" }],
          structuredContent: { ok: true },
        },
      },
    });
  });

  it("承認後にbindingが変わってもsnapshotのtargetだけを使う", async () => {
    const h = await executorHarness();
    // 別bindingのsnapshotで上書きはできない（INSERT-only）。
    const overwrite = await h.routes.save(
      snapshot({
        bindingVersion: 2,
        bindingFingerprint: "sha256:binding-v2",
        target: { mcpServerId: "ticket-server-v2", toolName: "set_priority" },
      }),
    );
    expect(Result.isFailure(overwrite)).toBe(true);

    await h.executor.execute(request());

    expect(h.downstream.calls[0]?.server.id).toBe("ticket-server");
  });

  it("snapshot欠落 / 不一致はnon-retriableで実行しない", async () => {
    const missing = await executorHarness({ route: null });
    const missingResult = await missing.executor.execute(request());
    const mismatched = await executorHarness({
      route: snapshot({ actionFingerprint: branded<ActionFingerprint>("sha256:other") }),
    });
    const mismatchedResult = await mismatched.executor.execute(request());

    assert(Result.isFailure(missingResult) && Result.isFailure(mismatchedResult));
    expect(missingResult.error).toMatchObject({
      code: "mcp_route_snapshot_missing",
      retriable: false,
    });
    expect(mismatchedResult.error).toMatchObject({
      code: "mcp_route_snapshot_mismatch",
      retriable: false,
    });
    expect(missing.downstream.calls).toHaveLength(0);
    expect(mismatched.downstream.calls).toHaveLength(0);
  });

  it("downstream CallToolResult isError=trueはtool-level resultとしてsucceededで保存する", async () => {
    const h = await executorHarness();
    h.downstream.outcome = Result.succeed({
      type: "result",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "locked" }],
        isError: true,
      },
    });

    const executed = await h.executor.execute(request());

    assert(Result.isSuccess(executed));
    expect(executed.value.output).toMatchObject({ result: { isError: true } });
  });

  it("downstream JSON-RPC errorはJSON-RPC codeを保持したnon-retriable error", async () => {
    const h = await executorHarness();
    h.downstream.outcome = Result.succeed({
      type: "jsonrpc_error",
      error: { code: -32602, message: "Unknown ticket" },
    });

    const executed = await h.executor.execute(request());

    assert(Result.isFailure(executed));
    expect(executed.error).toMatchObject({
      code: mcpJsonRpcExecutorErrorCode(-32602),
      retriable: false,
      detail: "Unknown ticket",
    });
  });

  it.each([
    ["not_sent", false, "best_effort_at_most_once", true],
    ["rejected", true, "best_effort_at_most_once", true],
    ["rejected", false, "idempotent", false],
    ["ambiguous", false, "best_effort_at_most_once", false],
    ["ambiguous", false, "idempotent", true],
  ] as const)(
    "transport失敗(effect=%s, retryable=%s, guarantee=%s)はretriable=%s",
    async (effect: McpDownstreamFailureEffect, retryable, guaranteeLevel, expected) => {
      const h = await executorHarness({ guaranteeLevel });
      h.downstream.outcome = Result.fail(
        new McpDownstreamTransportError("mcp_downstream_failure", effect, retryable, "failed"),
      );

      const executed = await h.executor.execute(request());

      assert(Result.isFailure(executed));
      expect(executed.error.retriable).toBe(expected);
      expect(h.executor.guaranteeLevel).toBe(guaranteeLevel);
    },
  );

  it("telemetryはActionRequest ID / MCP tool / downstream serverで相関する", async () => {
    const h = await executorHarness();
    h.downstream.outcome = Result.succeed({
      type: "jsonrpc_error",
      error: { code: -32000, message: "boom" },
    });

    await h.executor.execute(request());

    expect(h.telemetry.records).toEqual([
      expect.objectContaining({
        event: "executor.failed",
        correlation: expect.objectContaining({
          actionRequestId: "action-request:exec",
          component: "executor",
          operation: "mcp.tools.call",
        }),
        attributes: expect.objectContaining({
          errorCode: "mcp_jsonrpc_error:-32000",
          toolName: "ticket_set_priority",
          mcpServerId: "ticket-server",
          bindingVersion: 1,
        }),
      }),
    ]);
  });
});

describe("Streamable HTTP downstream client (MCP 2026-07-28)", () => {
  const server = { id: "ticket-server", endpoint: "https://tickets.example/mcp" };
  const call = {
    server,
    toolName: "set_priority",
    arguments: { ticketId: "T-1" },
    idempotencyKey: "idem",
    actionRequestId: "action-request:1",
  };

  function client(response: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return response(JSON.parse(init.body as string) as Record<string, unknown>);
    };
    return {
      requests,
      client: new StreamableHttpMcpDownstreamClient({
        fetch: fetcher,
        requestId: () => "rpc-1",
        credentials: {
          headers: () => Promise.resolve(Result.succeed({ authorization: "Bearer token" })),
        },
      }),
    };
  }

  it("tools/callをprotocol version / credential / idempotency key付きでPOSTする", async () => {
    const h = client(() =>
      Response.json({
        jsonrpc: "2.0",
        id: "rpc-1",
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    );

    const called = await h.client.callTool(call);

    assert(Result.isSuccess(called));
    expect(called.value).toEqual({
      type: "result",
      result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
    });
    const sent = h.requests[0];
    expect(sent?.url).toBe(server.endpoint);
    expect(sent?.init.headers).toMatchObject({
      authorization: "Bearer token",
      "mcp-protocol-version": MCP_PROTOCOL_REVISION,
      accept: "application/json, text/event-stream",
    });
    expect(JSON.parse(sent?.init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "tools/call",
      params: {
        name: "set_priority",
        arguments: { ticketId: "T-1" },
        _meta: {
          [MCP_EXECUTION_IDEMPOTENCY_KEY_META_KEY]: "idem",
          "dev.ultra-easy/actionRequestId": "action-request:1",
        },
      },
    });
  });

  it("SSE responseから同じidのJSON-RPC responseを読む", async () => {
    const h = client(
      () =>
        new Response(
          [
            'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
            'event: message\ndata: {"jsonrpc":"2.0","id":"rpc-1","error":{"code":-32602,"message":"bad"}}',
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const called = await h.client.callTool(call);

    assert(Result.isSuccess(called));
    expect(called.value).toEqual({
      type: "jsonrpc_error",
      error: { code: -32602, message: "bad" },
    });
  });

  it.each([
    [503, "rejected", true],
    [429, "rejected", true],
    [401, "rejected", false],
    [400, "rejected", false],
    [500, "ambiguous", false],
  ] as const)("HTTP %sはeffect=%s retryable=%s", async (status, effect, retryable) => {
    const h = client(() => new Response("error", { status }));

    const called = await h.client.callTool(call);

    assert(Result.isFailure(called));
    expect(called.error).toMatchObject({ effect, retryable });
  });

  it("network error / 不正response / CreateTaskResultはambiguous", async () => {
    const network = new StreamableHttpMcpDownstreamClient({
      fetch: () => Promise.reject(new TypeError("connection reset")),
    });
    const invalid = client(() => Response.json({ jsonrpc: "2.0", id: "other", result: {} }));
    const task = client(() =>
      Response.json({ jsonrpc: "2.0", id: "rpc-1", result: { resultType: "task", taskId: "t" } }),
    );

    for (const called of [
      await network.callTool(call),
      await invalid.client.callTool(call),
      await task.client.callTool(call),
    ]) {
      assert(Result.isFailure(called));
      expect(called.error.effect).toBe("ambiguous");
    }
  });
});
