import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { handleMcpGatewayHttpRequest, handleMcpGatewayJsonRpc } from "./jsonrpc.ts";
import {
  MCP_INVOCATION_KEY_META_KEY,
  MCP_PROTOCOL_REVISION,
  MCP_TASKS_EXTENSION,
  MCP_TASKS_EXTENSION_SEP,
  tasksCapableMeta,
} from "./protocol.ts";
import { createGatewayHarness, org, type GatewayHarness } from "./test-support.ts";

function harness(): GatewayHarness {
  const created = createGatewayHarness();
  assert(Result.isSuccess(created));
  return created.value;
}

function rpc(h: GatewayHarness, id: string | number, method: string, params?: unknown) {
  return handleMcpGatewayJsonRpc({
    gateway: h.gateway,
    organizationId: org,
    message: { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) },
  });
}

describe("MCP Gateway 5: protocol contract (MCP 2026-07-28 + Tasks SEP-2663)", () => {
  it("target contractをpinする", () => {
    expect(MCP_PROTOCOL_REVISION).toBe("2026-07-28");
    expect(MCP_TASKS_EXTENSION).toBe("io.modelcontextprotocol/tasks");
    expect(MCP_TASKS_EXTENSION_SEP).toBe("SEP-2663");
  });

  it("server/discoverはTasks extensionとlistChanged=falseを宣言する", async () => {
    expect(await rpc(harness(), 1, "server/discover")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: {
          tools: { listChanged: false },
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
        serverInfo: { name: "ultra-easy-mcp-gateway", version: "1.0.0" },
      },
    });
  });

  it("approval-required tools/call → CreateTaskResult → tasks/get completedのpayload shape", async () => {
    const h = harness();
    const created = await rpc(h, "call-1", "tools/call", {
      name: "ticket_set_priority",
      arguments: { ticketId: "T-1", priority: "critical" },
      _meta: tasksCapableMeta({ [MCP_INVOCATION_KEY_META_KEY]: "contract" }),
    });
    assert(created && "result" in created);
    const task = created.result as { taskId: string };
    expect(created).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        resultType: "task",
        taskId: task.taskId,
        status: "working",
        statusMessage: "ActionRequest is waiting for approval",
        createdAt: "2026-09-24T00:00:00.000Z",
        lastUpdatedAt: "2026-09-24T00:00:00.000Z",
        ttlMs: null,
        pollIntervalMs: 2000,
      },
    });

    h.setView("action-request:1", {
      status: "executed",
      result: {
        status: "executed",
        output: {
          kind: "mcp.call_tool_result",
          mcpServerId: "ticket-server",
          toolName: "set_priority",
          result: {
            resultType: "complete",
            content: [{ type: "text", text: "done" }],
            isError: true,
          },
        },
      },
      updatedAt: "2026-09-24T00:05:00.000Z",
    });
    expect(
      await rpc(h, "get-1", "tasks/get", { taskId: task.taskId, _meta: tasksCapableMeta() }),
    ).toEqual({
      jsonrpc: "2.0",
      id: "get-1",
      result: {
        resultType: "complete",
        taskId: task.taskId,
        status: "completed",
        statusMessage: "ActionRequest was executed",
        createdAt: "2026-09-24T00:00:00.000Z",
        lastUpdatedAt: "2026-09-24T00:05:00.000Z",
        ttlMs: null,
        pollIntervalMs: 2000,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "done" }],
          isError: true,
        },
      },
    });
  });

  it("tasks/getのfailedはJSON-RPC errorをerror fieldに持つ", async () => {
    const h = harness();
    const created = await rpc(h, 1, "tools/call", {
      name: "ticket_set_priority",
      arguments: { ticketId: "T-1", priority: "critical" },
      _meta: tasksCapableMeta(),
    });
    assert(created && "result" in created);
    const { taskId } = created.result as { taskId: string };
    h.setView("action-request:1", {
      status: "execution_failed",
      result: { status: "execution_failed", code: "mcp_jsonrpc_error:-32001", message: "down" },
    });

    const polled = await rpc(h, 2, "tasks/get", { taskId, _meta: tasksCapableMeta() });

    assert(polled && "result" in polled);
    expect(polled.result).toMatchObject({
      status: "failed",
      error: { code: -32001, message: "down" },
    });
    expect(polled.result).not.toHaveProperty("result");
  });

  it("JSON-RPC request idはlogical invocation identityに使わない", async () => {
    const h = harness();
    const params = (key: string) => ({
      name: "ticket_set_priority",
      arguments: { ticketId: "T-1", priority: "normal" },
      _meta: { [MCP_INVOCATION_KEY_META_KEY]: key },
    });

    const first = await rpc(h, 1, "tools/call", params("a"));
    const sameKeyOtherId = await rpc(h, 2, "tools/call", params("a"));
    const sameIdOtherKey = await rpc(h, 1, "tools/call", params("b"));

    assert(first && "result" in first && sameKeyOtherId && "result" in sameKeyOtherId);
    expect(sameKeyOtherId.result).toEqual(first.result);
    expect(sameIdOtherKey && "result" in sameIdOtherKey).toBe(true);
    expect(h.plans.plans.size).toBe(2);
    expect(h.downstream.calls).toHaveLength(2);
  });

  it("unknown method / invalid request / invalid paramsはJSON-RPC error", async () => {
    const h = harness();

    expect(await rpc(h, 1, "tools/unknown")).toMatchObject({ error: { code: -32601 } });
    expect(
      await handleMcpGatewayJsonRpc({ gateway: h.gateway, organizationId: org, message: [] }),
    ).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await rpc(h, 2, "tools/call", { arguments: {} })).toMatchObject({
      error: { code: -32602 },
    });
    expect(
      await rpc(h, 3, "tools/call", {
        name: "ticket_set_priority",
        _meta: { [MCP_INVOCATION_KEY_META_KEY]: "" },
      }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(await rpc(h, 4, "tasks/get", { _meta: tasksCapableMeta() })).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("HTTP handlerはprotocol version mismatchを400、notificationを202にする", async () => {
    const h = harness();
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      handleMcpGatewayHttpRequest({
        gateway: h.gateway,
        organizationId: org,
        request: new Request("https://gateway.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      });

    const mismatch = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(mismatch.status).toBe(400);

    const notification = await post({ jsonrpc: "2.0", method: "notifications/cancelled" });
    expect(notification.status).toBe(202);

    const listed = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      { "mcp-protocol-version": MCP_PROTOCOL_REVISION },
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        resultType: "complete",
        tools: [{ name: "ticket_close" }, { name: "ticket_set_priority" }],
      },
    });
  });
});
