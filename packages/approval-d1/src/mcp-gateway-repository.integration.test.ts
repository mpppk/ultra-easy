import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  createGatewayHarness,
  describeMcpInvocationRepositoryContract,
  describeMcpRouteSnapshotRepositoryContract,
} from "@app/approval-mcp/testing";

import {
  D1McpInvocationRepository,
  D1McpRouteSnapshotRepository,
} from "./mcp-gateway-repository.ts";
import { migratedSqliteD1 } from "./testing/index.ts";

describeMcpInvocationRepositoryContract(
  "D1McpInvocationRepository",
  () => new D1McpInvocationRepository(migratedSqliteD1()),
);
describeMcpRouteSnapshotRepositoryContract(
  "D1McpRouteSnapshotRepository",
  () => new D1McpRouteSnapshotRepository(migratedSqliteD1()),
);

describe("MCP Gateway on D1: durable Task reservation / recovery", () => {
  function harness() {
    const db = migratedSqliteD1();
    const created = createGatewayHarness({
      invocationRepository: () => new D1McpInvocationRepository(db),
      routeSnapshotRepository: new D1McpRouteSnapshotRepository(db),
    });
    assert(Result.isSuccess(created));
    return { ...created.value, db };
  }

  const critical = { ticketId: "T-1", priority: "critical" };

  it("commit failure後もD1に残ったTask予約から同じTask ID / ActionRequestで復旧する", async () => {
    const h = harness();
    h.workflows.failures = 1;

    const failed = await h.call(critical, { key: "d1-recover" });
    assert(failed.type === "error");
    const taskId = failed.error.data?.taskId;
    expect(typeof taskId).toBe("string");

    const row = h.db.db
      .prepare("SELECT status, task_id, action_request_id FROM mcp_invocations")
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      status: "prepared",
      task_id: taskId,
      action_request_id: "action-request:1",
    });

    const recovered = await h.call(critical, { key: "d1-recover" });
    assert(recovered.type === "result" && recovered.result.resultType === "task");
    expect(recovered.result.taskId).toBe(taskId);
    expect(h.plans.plans.size).toBe(1);
    expect(h.workflows.starts).toHaveLength(1);

    const polled = await h.getTask(String(taskId));
    assert(polled.type === "result");
    expect(polled.result.status).toBe("working");
  });

  it("route snapshotはActionRequestごとにD1へ保存され、immediate executionで利用される", async () => {
    const h = harness();

    const result = await h.call({ ticketId: "T-2", priority: "normal" }, { key: "d1-route" });

    expect(result.type).toBe("result");
    expect(h.downstream.calls[0]?.toolName).toBe("set_priority");
    const row = h.db.db
      .prepare("SELECT action_request_id, binding_fingerprint FROM mcp_route_snapshots")
      .get() as Record<string, unknown>;
    expect(row.action_request_id).toBe("action-request:1");
    expect(String(row.binding_fingerprint)).toMatch(/^sha256:/);
  });
});
