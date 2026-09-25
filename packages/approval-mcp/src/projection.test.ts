import { describe, expect, it } from "vite-plus/test";

import type { ActionRequestView } from "@app/approval-application";

import {
  MCP_CALL_TOOL_OUTPUT_KIND,
  mcpJsonRpcExecutorErrorCode,
  parseMcpJsonRpcExecutorErrorCode,
  projectActionRequest,
  projectMcpTask,
} from "./projection.ts";
import type { McpInvocationRecord } from "./invocation.ts";
import { alice, org, priorityActionType, T0, ticket } from "./test-support.ts";

function view(
  status: ActionRequestView["status"],
  result?: ActionRequestView["result"],
): ActionRequestView {
  return {
    id: "action-request:1" as ActionRequestView["id"],
    organizationId: org,
    actor: { type: "user", id: alice },
    authorityPrincipal: { type: "user", id: alice },
    action: {
      type: priorityActionType,
      resource: { type: ticket, id: "T-1" as never },
      input: {},
    },
    origin: "mcp",
    status,
    approval: { required: true },
    ...(result ? { result } : {}),
    checksums: {
      actionFingerprint: "sha256:a",
      evaluationSnapshotChecksum: "sha256:b",
      approvalPlanChecksum: "sha256:c",
    },
    createdAt: T0,
    updatedAt: "2026-09-24T00:10:00.000Z",
  };
}

const downstream = (isError: boolean) => ({
  kind: MCP_CALL_TOOL_OUTPUT_KIND,
  mcpServerId: "ticket-server",
  toolName: "set_priority",
  result: {
    resultType: "complete",
    content: [{ type: "text", text: isError ? "ticket is locked" : "ok" }],
    ...(isError ? { isError: true } : {}),
  },
});

describe("MCP Gateway 5: Task lifecycle projection (MCP 2026-07-28 Tasks)", () => {
  it.each([
    ["pending_approval", "working"],
    ["approved", "working"],
    ["executing", "working"],
  ] as const)("%s → %s", (status, expected) => {
    expect(projectActionRequest(view(status)).status).toBe(expected);
  });

  it("downstream CallToolResult successはcompleted + result", () => {
    expect(
      projectActionRequest(view("executed", { status: "executed", output: downstream(false) })),
    ).toEqual({
      status: "completed",
      statusMessage: "ActionRequest was executed",
      result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
    });
  });

  it("downstream CallToolResult { isError: true } はfailedではなくcompleted + result.isError", () => {
    const projected = projectActionRequest(
      view("executed", { status: "executed", output: downstream(true) }),
    );
    expect(projected.status).toBe("completed");
    expect(projected.status === "completed" && projected.result.isError).toBe(true);
  });

  it.each(["rejected", "expired", "authorization_revoked"] as const)(
    "%s はcompleted + tool-level error result",
    (status) => {
      const projected = projectActionRequest(view(status));
      expect(projected.status).toBe("completed");
      expect(projected.status === "completed" && projected.result).toMatchObject({
        isError: true,
        structuredContent: { actionRequestId: "action-request:1", status },
      });
    },
  );

  it("downstream JSON-RPC errorはfailed + 元のerror code", () => {
    expect(
      projectActionRequest(
        view("execution_failed", {
          status: "execution_failed",
          code: mcpJsonRpcExecutorErrorCode(-32602),
          message: "Invalid arguments for tool set_priority",
        }),
      ),
    ).toEqual({
      status: "failed",
      statusMessage: "Tool execution failed",
      error: {
        code: -32602,
        message: "Invalid arguments for tool set_priority",
        data: { actionRequestId: "action-request:1", provenance: "downstream" },
      },
    });
  });

  it("adapter / internal failureはfailed + -32603 error", () => {
    for (const [status, provenance] of [
      ["execution_failed", "execution"],
      ["authorization_check_failed", "reauthorization"],
    ] as const) {
      expect(
        projectActionRequest(view(status, { status, code: "mcp_downstream_timeout" })),
      ).toMatchObject({
        status: "failed",
        error: { code: -32603, data: { provenance, code: "mcp_downstream_timeout" } },
      });
    }
  });

  it("cancelledはcancelled", () => {
    expect(projectActionRequest(view("cancelled")).status).toBe("cancelled");
  });

  it("JSON-RPC executor error codeはround-tripし、それ以外はnull", () => {
    expect(parseMcpJsonRpcExecutorErrorCode(mcpJsonRpcExecutorErrorCode(-32001))).toBe(-32001);
    expect(parseMcpJsonRpcExecutorErrorCode("mcp_downstream_timeout")).toBeNull();
    expect(parseMcpJsonRpcExecutorErrorCode(undefined)).toBeNull();
  });

  it("tasks/get payload shapeはresult / errorをstatusに応じて1つだけ持つ", () => {
    const record: McpInvocationRecord = {
      organizationId: org,
      invocationId: "invocation",
      owner: {
        organizationId: org,
        actor: { type: "user", id: alice },
        authorityPrincipal: { type: "user", id: alice },
      },
      invocationKey: "key",
      keySource: "client",
      requestHash: "hash",
      toolName: "ticket_set_priority",
      status: "committed",
      leaseToken: "lease",
      leaseExpiresAt: T0,
      actionRequestId: "action-request:1" as never,
      taskId: "task_1",
      taskCreatedAt: T0,
      ttlMs: null,
      createdAt: T0,
      updatedAt: T0,
    };

    expect(
      projectMcpTask({
        record,
        view: view("executed", { status: "executed", output: downstream(false) }),
        pollIntervalMs: 1000,
      }),
    ).toEqual({
      resultType: "complete",
      taskId: "task_1",
      status: "completed",
      statusMessage: "ActionRequest was executed",
      createdAt: T0,
      lastUpdatedAt: "2026-09-24T00:10:00.000Z",
      ttlMs: null,
      pollIntervalMs: 1000,
      result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
    });
    const failed = projectMcpTask({
      record,
      view: view("execution_failed", { status: "execution_failed", code: "x" }),
      pollIntervalMs: 1000,
    });
    expect(failed).toHaveProperty("error");
    expect(failed).not.toHaveProperty("result");
    const working = projectMcpTask({
      record,
      view: view("pending_approval"),
      pollIntervalMs: 1000,
    });
    expect(working).not.toHaveProperty("result");
    expect(working).not.toHaveProperty("error");
  });
});
