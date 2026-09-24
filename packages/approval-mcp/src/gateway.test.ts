import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ClientId, OrganizationId } from "@app/approval-core";

import {
  invocationOwner,
  leaseLostError,
  mcpInvocationId,
  mcpInvocationRequestHash,
  type McpInvocationRepository,
} from "./invocation.ts";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  MCP_INVOCATION_CONFLICT,
  MCP_INVOCATION_IN_PROGRESS,
  MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_RATE_LIMITED,
  MCP_TASK_OPERATION_FORBIDDEN,
  MCP_TASKS_EXTENSION,
  tasksCapableMeta,
  unknownToolError,
} from "./protocol.ts";
import {
  alice,
  branded,
  closeBinding,
  createGatewayHarness,
  mallory,
  mcpContext,
  org,
  otherOrg,
  priorityBinding,
  T0,
  type GatewayHarness,
} from "./test-support.ts";

function harness(options: Parameters<typeof createGatewayHarness>[0] = {}): GatewayHarness {
  const created = createGatewayHarness(options);
  assert(Result.isSuccess(created));
  return created.value;
}

function taskIdOf(outcome: Awaited<ReturnType<GatewayHarness["call"]>>): string {
  assert(outcome.type === "result");
  assert(outcome.result.resultType === "task");
  return outcome.result.taskId;
}

const critical = { ticketId: "T-1", priority: "critical" };
const normal = { ticketId: "T-1", priority: "normal" };

describe("MCP Gateway 2: Tool Exposure / tools/list", () => {
  it("tools/listはExposure allowのtoolだけをBinding由来のschemaで返す", async () => {
    const h = harness();
    h.exposure.denied.add("ticket.close");

    const listed = await h.gateway.listTools({ organizationId: org });

    expect(listed).toEqual({
      type: "result",
      result: {
        resultType: "complete",
        tools: [
          {
            name: "ticket_set_priority",
            description: priorityBinding().exposedTool.description,
            inputSchema: priorityBinding().exposedTool.inputSchema,
          },
        ],
      },
    });
  });

  it("principal / client identityごとに返るtool一覧を変えられる", async () => {
    const h = harness();
    h.exposure.denied.add("client:restricted");

    const full = await h.gateway.listTools({ organizationId: org });
    h.setContext(
      mcpContext({
        origin: { type: "mcp", clientId: branded<ClientId>("client:restricted") },
      }),
    );
    const restricted = await h.gateway.listTools({ organizationId: org });

    assert(full.type === "result" && restricted.type === "result");
    expect(full.result.tools.map((tool) => tool.name)).toEqual([
      "ticket_close",
      "ticket_set_priority",
    ]);
    expect(restricted.result.tools).toEqual([]);
  });

  it("organization境界を越えたbindingは返さない", async () => {
    const h = harness({
      bindings: [priorityBinding(), closeBinding({ organizationId: otherOrg })],
    });

    const listed = await h.gateway.listTools({ organizationId: org });

    assert(listed.type === "result");
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["ticket_set_priority"]);
  });

  it("委任scopeがActionTypeを許可しないtoolはproviderへ問い合わせずhideする", async () => {
    const h = harness();
    const context = mcpContext();
    context.authority.delegation!.chain[0]!.scope = { actionTypes: [priorityBinding().actionType] };
    h.setContext(context);

    const listed = await h.gateway.listTools({ organizationId: org });

    assert(listed.type === "result");
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["ticket_set_priority"]);
    expect(h.exposure.calls.map((call) => call.toolName)).toEqual(["ticket_set_priority"]);
  });

  it("Exposure provider error時はfail-closedで部分的な一覧を返さない", async () => {
    const h = harness();
    h.exposure.failing = true;

    const listed = await h.gateway.listTools({ organizationId: org });

    expect(listed).toMatchObject({ type: "error", error: { code: JSONRPC_INTERNAL_ERROR } });
  });

  it("paginationはcursorで次ページを返し、不正cursorは-32602", async () => {
    const h = harness({ listPageSize: 1 });

    const first = await h.gateway.listTools({ organizationId: org });
    assert(first.type === "result");
    expect(first.result.tools.map((tool) => tool.name)).toEqual(["ticket_close"]);
    assert(first.result.nextCursor);

    const second = await h.gateway.listTools({
      organizationId: org,
      params: { cursor: first.result.nextCursor },
    });
    assert(second.type === "result");
    expect(second.result.tools.map((tool) => tool.name)).toEqual(["ticket_set_priority"]);
    expect(second.result.nextCursor).toBeUndefined();

    const invalid = await h.gateway.listTools({
      organizationId: org,
      params: { cursor: "%%%" },
    });
    expect(invalid).toMatchObject({ type: "error", error: { code: JSONRPC_INVALID_PARAMS } });
  });

  it("exposure=deny / ActionAuthorizer=allowでもcallは拒否されActionRequest等は0件", async () => {
    const h = harness();
    h.exposure.denied.add("ticket.priority.change");

    const result = await h.call(critical, { key: "hidden" });

    expect(result).toEqual({ type: "error", error: unknownToolError("ticket_set_priority") });
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.authorizer.calls).toHaveLength(0);
    expect(h.plans.plans.size).toBe(0);
    expect(h.workflows.starts).toHaveLength(0);
    expect(h.downstream.calls).toHaveLength(0);
    expect(h.invocations.all()).toHaveLength(0);
  });

  it("hidden toolとunknown toolは外部から区別できない同じerror shapeになる", async () => {
    const h = harness();
    h.exposure.denied.add("ticket.close");

    const hidden = await h.call({ ticketId: "T-1" }, { name: "ticket_close" });
    const unknown = await h.call({ ticketId: "T-1" }, { name: "ticket_delete" });

    expect(hidden).toEqual({ type: "error", error: unknownToolError("ticket_close") });
    expect(unknown).toEqual({ type: "error", error: unknownToolError("ticket_delete") });
  });

  it("exposure=allow / ActionAuthorizer=denyはFull Authorizationで拒否される", async () => {
    const h = harness();
    h.authorizer.allowed = false;

    const result = await h.call(critical, { key: "denied" });

    assert(result.type === "result" && result.result.resultType === "complete");
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent).toMatchObject({ code: "fga_check_denied" });
    expect(h.authorizer.calls).toHaveLength(1);
    expect(h.plans.plans.size).toBe(0);
    expect(h.workflows.starts).toHaveLength(0);
    expect(h.downstream.calls).toHaveLength(0);
  });

  it("visible toolでもtools/call時にはFull Authorizationを必ず実行する", async () => {
    const h = harness();

    await h.gateway.listTools({ organizationId: org });
    await h.call(normal, { key: "visible" });

    // initial Authorization + 実行直前Re-Authorization
    expect(h.authorizer.calls.map((call) => call.consistency)).toEqual([
      "minimize_latency",
      "higher_consistency",
    ]);
    expect(h.authorizer.calls[0]?.request.action).toMatchObject({
      resource: { type: "ticket", id: "T-1" },
      input: { priority: "normal" },
    });
  });

  it("Exposure provider error時のtools/callはActionRequestを作らない", async () => {
    const h = harness();
    h.exposure.failing = true;

    const result = await h.call(normal, { key: "provider-down" });

    expect(result).toMatchObject({ type: "error", error: { code: JSONRPC_INTERNAL_ERROR } });
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.plans.plans.size).toBe(0);
  });
});

describe("MCP Gateway 3: tools/call → ActionRequest pipeline", () => {
  it("no-approval actionはcommit後にdownstream toolを実行しCallToolResultを返す", async () => {
    const h = harness();

    const result = await h.call(normal, { key: "immediate", tasks: false });

    expect(result).toEqual({
      type: "result",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "priority updated" }],
        structuredContent: { ok: true },
      },
    });
    expect(h.plans.plans.size).toBe(1);
    expect(h.downstream.calls).toHaveLength(1);
    expect(h.downstream.calls[0]).toMatchObject({
      toolName: "set_priority",
      arguments: { ticketId: "T-1", priority: "normal" },
    });
  });

  it("approval-required actionはcommit後に既存workflowへ進みMCP Taskを返す", async () => {
    const h = harness();

    const result = await h.call(critical, { key: "approval" });

    expect(result).toEqual({
      type: "result",
      result: {
        resultType: "task",
        taskId: expect.stringMatching(/^task_/),
        status: "working",
        statusMessage: "ActionRequest is waiting for approval",
        createdAt: expect.any(String),
        lastUpdatedAt: expect.any(String),
        ttlMs: null,
        pollIntervalMs: 2000,
      },
    });
    expect(h.workflows.starts).toHaveLength(1);
    expect(h.downstream.calls).toHaveLength(0);
  });

  it("body/argumentsからactor/authority/organizationを偽装できない", async () => {
    const h = harness();

    await h.call(
      {
        ...normal,
        actor: { type: "user", id: String(mallory) },
        authority: { principal: { type: "user", id: String(mallory) } },
        organizationId: String(otherOrg),
      },
      { key: "spoof" },
    );

    const request = h.authorizer.calls[0]?.request;
    expect(request?.actor).toEqual(mcpContext().actor);
    expect(request?.authority.principal).toEqual({ type: "user", id: alice });
    const plan = [...h.plans.plans.values()][0];
    expect(String(plan?.organizationId)).toBe(String(org));
    expect(plan?.evaluationSnapshot.origin).toMatchObject({
      type: "mcp",
      clientId: "client:claude",
    });
  });

  it("mcp origin以外 / 別organizationのtrusted contextはfail-closedでActionRequestを作らない", async () => {
    const h = harness();
    h.setContext(mcpContext({ origin: { type: "api" } }));
    const nonMcp = await h.call(normal, { key: "api" });
    h.setContext(mcpContext({ organization: { id: otherOrg } }));
    const crossTenant = await h.call(normal, { key: "cross", organizationId: org });

    expect(nonMcp).toMatchObject({ type: "error", error: { code: JSONRPC_INTERNAL_ERROR } });
    expect(crossTenant).toMatchObject({ type: "error", error: { code: JSONRPC_INTERNAL_ERROR } });
    expect(h.prepareCalls).toHaveLength(0);
  });

  it("invalid argumentsは-32602でActionRequestを作らずkeyを解放する", async () => {
    const h = harness();

    const missing = await h.call({ priority: "normal" }, { key: "invalid" });
    const invalidInput = await h.call({ ticketId: "T-1", priority: 1 }, { key: "schema" });

    expect(missing).toMatchObject({
      type: "error",
      error: { code: JSONRPC_INVALID_PARAMS, data: { path: "ticketId" } },
    });
    expect(invalidInput).toMatchObject({
      type: "error",
      error: {
        code: JSONRPC_INVALID_PARAMS,
        data: { code: "action_input_validation_failed", issues: [{ path: "priority" }] },
      },
    });
    expect(h.plans.plans.size).toBe(0);
    expect(h.invocations.all()).toHaveLength(0);

    const retried = await h.call(normal, { key: "invalid" });
    expect(retried.type).toBe("result");
  });

  it("same key + same requestは同じActionRequest / final resultへ収束しdownstreamを再実行しない", async () => {
    const h = harness();

    const first = await h.call(normal, { key: "replay" });
    const second = await h.call(normal, { key: "replay" });

    expect(second).toEqual(first);
    expect(h.plans.plans.size).toBe(1);
    expect(h.downstream.calls).toHaveLength(1);
    expect(h.prepareCalls).toHaveLength(1);
  });

  it("approval待ちのreplayは同じMCP Taskを返しActionRequest / Workflowを増やさない", async () => {
    const h = harness();

    const taskId = taskIdOf(await h.call(critical, { key: "pending" }));
    const replay = await h.call(critical, { key: "pending" });

    expect(taskIdOf(replay)).toBe(taskId);
    expect(h.plans.plans.size).toBe(1);
    expect(h.workflows.starts).toHaveLength(1);
  });

  it("terminal後のreplayは同じTaskの最終状態を返す", async () => {
    const h = harness();
    const taskId = taskIdOf(await h.call(critical, { key: "terminal" }));
    const actionRequestId = String([...h.plans.plans.keys()][0]);
    h.setView(actionRequestId, { status: "rejected", updatedAt: "2026-09-24T01:00:00.000Z" });

    const replay = await h.call(critical, { key: "terminal" });

    assert(replay.type === "result" && replay.result.resultType === "task");
    expect(replay.result).toMatchObject({ taskId, status: "completed" });
  });

  it("same key + different requestはconflict", async () => {
    const h = harness();

    await h.call(normal, { key: "conflict" });
    const conflict = await h.call({ ...normal, priority: "low" }, { key: "conflict" });

    expect(conflict).toMatchObject({ type: "error", error: { code: MCP_INVOCATION_CONFLICT } });
    expect(h.plans.plans.size).toBe(1);
  });

  it("invocation keyはprincipal / client scopeで閉じ、別clientの同じkeyは別invocation", async () => {
    const h = harness();

    await h.call(normal, { key: "shared" });
    h.setContext(
      mcpContext({ origin: { type: "mcp", clientId: branded<ClientId>("client:other") } }),
    );
    const other = await h.call({ ...normal, priority: "low" }, { key: "shared" });

    expect(other.type).toBe("result");
    expect(h.plans.plans.size).toBe(2);
  });

  it("concurrent same-key callでActionRequest / Workflowが重複しない", async () => {
    const h = harness();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.call(critical, { key: "concurrent" })),
    );

    expect(h.plans.plans.size).toBe(1);
    expect(h.workflows.starts).toHaveLength(1);
    const tasks = results.filter((result) => result.type === "result");
    const inProgress = results.filter(
      (result) => result.type === "error" && result.error.code === MCP_INVOCATION_IN_PROGRESS,
    );
    expect(tasks).toHaveLength(1);
    expect(inProgress).toHaveLength(4);
  });

  it("stale pending reservationはlease期限後に回収できる", async () => {
    const h = harness();
    const context = mcpContext();
    const owner = invocationOwner({
      organizationId: org,
      actor: context.actor,
      authority: context.authority,
      origin: context.origin,
    });
    const invocationId = await mcpInvocationId({ owner, invocationKey: "stale" });
    const requestHash = await mcpInvocationRequestHash({
      toolName: "ticket_set_priority",
      arguments: normal,
    });
    assert(Result.isSuccess(invocationId) && Result.isSuccess(requestHash));
    // reserve直後（prepare前）にcrashしたisolateのreservationを模擬する。
    await h.invocations.reserve({
      organizationId: org,
      invocationId: invocationId.value,
      owner,
      invocationKey: "stale",
      keySource: "client",
      requestHash: requestHash.value,
      toolName: "ticket_set_priority",
      status: "reserved",
      leaseToken: "crashed-isolate",
      leaseExpiresAt: "2026-09-24T00:00:30.000Z",
      createdAt: T0,
      updatedAt: T0,
    });

    const blocked = await h.call(normal, { key: "stale" });
    expect(blocked).toMatchObject({ type: "error", error: { code: MCP_INVOCATION_IN_PROGRESS } });
    expect(h.prepareCalls).toHaveLength(0);

    h.advance(31_000);
    const recovered = await h.call(normal, { key: "stale" });
    expect(recovered.type).toBe("result");
    expect(h.plans.plans.size).toBe(1);
    expect(h.downstream.calls).toHaveLength(1);
  });

  it("rate limit超過は-32029で、replayはrate limitを消費しない", async () => {
    const h = harness({ rateLimitPolicy: { limit: 1, windowSeconds: 60 } });

    const first = await h.call(normal, { key: "rate-1" });
    const replay = await h.call(normal, { key: "rate-1" });
    const limited = await h.call(normal, { key: "rate-2" });

    expect(first.type).toBe("result");
    expect(replay).toEqual(first);
    expect(limited).toMatchObject({
      type: "error",
      error: { code: MCP_RATE_LIMITED, data: { retryAfterSeconds: 60, limit: 1 } },
    });
    expect(h.plans.plans.size).toBe(1);
  });

  it("telemetryはinvocation → ActionRequest → tool / serverを相関しargumentsを含めない", async () => {
    const h = harness();

    await h.call({ ...normal, secret: "DO-NOT-LOG" }, { key: "telemetry" });

    const accepted = h.telemetry.records.find(
      (record) => record.kind === "log" && record.event === "request.accepted",
    );
    expect(accepted).toMatchObject({
      correlation: {
        organizationId: org,
        actionRequestId: "action-request:1",
        correlationId: "action-request:1",
        mcpInvocationId: expect.any(String),
        component: "mcp",
        operation: "tools.call",
      },
      attributes: {
        toolName: "ticket_set_priority",
        mcpServerId: "ticket-server",
        bindingVersion: 1,
      },
    });
    const executed = h.telemetry.records.find(
      (record) => record.kind === "log" && record.event === "executor.completed",
    );
    expect(executed).toMatchObject({
      correlation: { actionRequestId: "action-request:1", component: "executor" },
      attributes: { toolName: "ticket_set_priority", mcpServerId: "ticket-server" },
    });
    expect(JSON.stringify(h.telemetry.records)).not.toContain("DO-NOT-LOG");
    expect(JSON.stringify(h.telemetry.records)).not.toContain("normal");
  });
});

describe("MCP Gateway 5: Tasks admission / durable reservation (#98)", () => {
  it("Tasks非対応clientではapproval-required Prepared ActionRequestをcommitしない", async () => {
    const h = harness();

    const result = await h.call(critical, { key: "no-tasks", tasks: false });

    expect(result).toEqual({
      type: "error",
      error: {
        code: MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
        message: "Missing required client capability",
        data: { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } },
      },
    });
    expect(h.plans.plans.size).toBe(0);
    expect(h.workflows.starts).toHaveLength(0);
    expect(h.invocations.all()).toHaveLength(0);

    // 同じkeyでTasks capabilityを宣言すれば、孤立なく同じlogical callを実行できる。
    const retried = await h.call(critical, { key: "no-tasks" });
    taskIdOf(retried);
    expect(h.plans.plans.size).toBe(1);
  });

  it("Tasks非対応clientでもno-approval toolは実行できる", async () => {
    const h = harness();

    const result = await h.call(normal, { key: "no-tasks-immediate", tasks: false });

    assert(result.type === "result" && result.result.resultType === "complete");
    expect(h.downstream.calls).toHaveLength(1);
  });

  it("Task reservation失敗ではActionRequest / Workflowをcommitしない", async () => {
    const h = harness({
      invocationRepository: (inner): McpInvocationRepository => ({
        reserve: (record) => inner.reserve(record),
        takeOver: (input) => inner.takeOver(input),
        release: (input) => inner.release(input),
        load: (input) => inner.load(input),
        loadByTaskId: (input) => inner.loadByTaskId(input),
        update: (input) =>
          input.patch.status === "prepared"
            ? Promise.resolve(Result.fail(leaseLostError()))
            : inner.update(input),
      }),
    });

    const result = await h.call(critical, { key: "reservation-fails" });

    expect(result).toMatchObject({ type: "error", error: { code: JSONRPC_INTERNAL_ERROR } });
    expect(h.plans.plans.size).toBe(0);
    expect(h.workflows.starts).toHaveLength(0);
  });

  it("Task reservation後のcommit failureは同じinvocation / Task IDで復旧できる", async () => {
    const h = harness();
    h.workflows.failures = 1;

    const failed = await h.call(critical, { key: "recover" });
    assert(failed.type === "error");
    expect(failed.error).toMatchObject({
      code: JSONRPC_INTERNAL_ERROR,
      data: { code: "workflow_start_failed", retriable: true, taskId: expect.any(String) },
    });
    const reservedTaskId = failed.error.data?.taskId;
    expect(h.plans.plans.size).toBe(1);
    expect(h.workflows.starts).toHaveLength(0);

    const recovered = await h.call(critical, { key: "recover" });

    expect(taskIdOf(recovered)).toBe(reservedTaskId);
    expect(h.plans.plans.size).toBe(1);
    expect(h.workflows.starts).toHaveLength(1);
    expect(h.prepareCalls).toHaveLength(1);
    expect(String(h.workflows.starts[0]?.actionRequestId)).toBe("action-request:1");
  });

  it("Plan保存後のnon-retriableなWorkflow開始失敗も孤立させず回収対象にする", async () => {
    const h = harness();
    h.workflows.failures = 1;
    h.workflows.retriable = false;

    const failed = await h.call(critical, { key: "non-retriable" });
    assert(failed.type === "error");
    expect(failed.error.data).toMatchObject({
      code: "workflow_start_failed",
      actionRequestId: "action-request:1",
    });

    const recovered = await h.call(critical, { key: "non-retriable" });
    taskIdOf(recovered);
    expect(h.workflows.starts).toHaveLength(1);
    expect(h.plans.plans.size).toBe(1);
  });

  it("tasks/get pollingでの回収もTool Exposureを再確認する", async () => {
    const h = harness();
    h.workflows.failures = 1;
    const failed = await h.call(critical, { key: "poll-hidden" });
    assert(failed.type === "error");
    const taskId = String(failed.error.data?.taskId);
    h.exposure.denied.add("ticket.priority.change");

    const polled = await h.getTask(taskId);

    assert(polled.type === "result");
    expect(polled.result).toMatchObject({ taskId, status: "working" });
    expect(h.workflows.starts).toHaveLength(0);
  });

  it("commit未完了のTaskはtasks/get pollingでも同じPlanで回収される", async () => {
    const h = harness();
    h.workflows.failures = 1;
    const failed = await h.call(critical, { key: "poll-recover" });
    assert(failed.type === "error");
    const taskId = String(failed.error.data?.taskId);

    const polled = await h.getTask(taskId);

    assert(polled.type === "result");
    expect(polled.result).toMatchObject({ taskId, status: "working" });
    expect(h.workflows.starts).toHaveLength(1);
    const replay = await h.call(critical, { key: "poll-recover" });
    expect(taskIdOf(replay)).toBe(taskId);
    expect(h.workflows.starts).toHaveLength(1);
  });

  it("commit前にcancelされたTaskは再送してもcommitされない", async () => {
    const h = harness();
    h.workflows.failures = 1;
    const failed = await h.call(critical, { key: "cancel-before-commit" });
    assert(failed.type === "error");
    const taskId = String(failed.error.data?.taskId);

    const cancelled = await h.gateway.cancelTask({
      organizationId: org,
      params: { taskId, _meta: tasksCapableMeta() },
    });
    expect(cancelled).toEqual({ type: "result", result: { resultType: "complete" } });

    const replay = await h.call(critical, { key: "cancel-before-commit" });
    assert(replay.type === "result" && replay.result.resultType === "task");
    expect(replay.result.status).toBe("cancelled");
    expect(h.workflows.starts).toHaveLength(0);
  });
});

describe("MCP Gateway 5: Task ownership / access control", () => {
  async function pendingTask(h: GatewayHarness): Promise<string> {
    return taskIdOf(await h.call(critical, { key: `task-${Math.random()}` }));
  }

  it("tasks/*はTasks capability未宣言clientに-32021を返す", async () => {
    const h = harness();
    const taskId = await pendingTask(h);

    for (const outcome of [
      await h.getTask(taskId, false),
      await h.gateway.updateTask({ organizationId: org, params: { taskId, inputResponses: {} } }),
      await h.gateway.cancelTask({ organizationId: org, params: { taskId } }),
    ]) {
      expect(outcome).toMatchObject({
        type: "error",
        error: { code: MCP_MISSING_REQUIRED_CLIENT_CAPABILITY },
      });
    }
  });

  it("Task IDだけではread/update/cancelできない（別actor / client / organization）", async () => {
    const h = harness();
    const taskId = await pendingTask(h);

    const strangers = [
      mcpContext({ actor: { type: "user", id: mallory } }),
      mcpContext({ authority: { principal: { type: "user", id: mallory } } }),
      mcpContext({ origin: { type: "mcp", clientId: branded<ClientId>("client:other") } }),
      mcpContext({
        origin: { type: "mcp", clientId: branded<ClientId>("client:claude") },
      }),
    ];
    for (const context of strangers) {
      h.setContext(context);
      for (const outcome of [
        await h.getTask(taskId),
        await h.gateway.updateTask({
          organizationId: org,
          params: { taskId, inputResponses: {}, _meta: tasksCapableMeta() },
        }),
        await h.gateway.cancelTask({
          organizationId: org,
          params: { taskId, _meta: tasksCapableMeta() },
        }),
      ]) {
        expect(outcome).toEqual({
          type: "error",
          error: {
            code: JSONRPC_INVALID_PARAMS,
            message: "Failed to retrieve task: Task not found",
          },
        });
      }
    }

    h.setContext(mcpContext({ organization: { id: otherOrg } }));
    const crossTenant = await h.gateway.getTask({
      organizationId: branded<OrganizationId>(String(otherOrg)),
      params: { taskId, _meta: tasksCapableMeta() },
    });
    expect(crossTenant).toMatchObject({ type: "error", error: { code: JSONRPC_INVALID_PARAMS } });
  });

  it("reconnect後も同じstable identityなら同じTaskを取得できる", async () => {
    const h = harness();
    const taskId = await pendingTask(h);

    // transport sessionは持たないため、新しいcontext objectでも同じowner identityなら照合できる。
    h.setContext(structuredClone(mcpContext()));
    const polled = await h.getTask(taskId);

    assert(polled.type === "result");
    expect(polled.result).toMatchObject({ resultType: "complete", taskId, status: "working" });
  });

  it("明示的read permissionはget可能にするがupdate / cancelは許可しない", async () => {
    const h = harness({
      taskAccessAuthorizer: {
        canRead: (input) =>
          Promise.resolve(
            Result.succeed(
              input.requester.actor.type === "user" &&
                String(input.requester.actor.id) === String(mallory),
            ),
          ),
      },
      canceller: {
        cancel: () => Promise.resolve(Result.succeed({ type: "accepted" as const })),
      },
    });
    const taskId = await pendingTask(h);
    h.setContext(mcpContext({ actor: { type: "user", id: mallory } }));

    const read = await h.getTask(taskId);
    const updated = await h.gateway.updateTask({
      organizationId: org,
      params: { taskId, inputResponses: {}, _meta: tasksCapableMeta() },
    });
    const cancelled = await h.gateway.cancelTask({
      organizationId: org,
      params: { taskId, _meta: tasksCapableMeta() },
    });

    expect(read.type).toBe("result");
    expect(updated).toMatchObject({ type: "error", error: { code: MCP_TASK_OPERATION_FORBIDDEN } });
    expect(cancelled).toMatchObject({
      type: "error",
      error: { code: MCP_TASK_OPERATION_FORBIDDEN },
    });
  });

  it("tasks/updateはownerにackし、v1では未発行のinputResponsesを無視する", async () => {
    const h = harness();
    const taskId = await pendingTask(h);

    const updated = await h.gateway.updateTask({
      organizationId: org,
      params: {
        taskId,
        inputResponses: { unknown: { action: "accept" } },
        _meta: tasksCapableMeta(),
      },
    });

    expect(updated).toEqual({ type: "result", result: { resultType: "complete" } });
    const polled = await h.getTask(taskId);
    assert(polled.type === "result");
    expect(polled.result.status).toBe("working");
  });

  it("tasks/cancelはowner確認に加えActionRequest cancellation authorizationを満たす必要がある", async () => {
    const requests: unknown[] = [];
    let decision: "accepted" | "denied" = "denied";
    const h = harness({
      canceller: {
        cancel(input) {
          requests.push(input);
          return Promise.resolve(
            Result.succeed(
              decision === "accepted"
                ? { type: "accepted" as const }
                : { type: "denied" as const, code: "cancel_not_permitted" },
            ),
          );
        },
      },
    });
    const taskId = await pendingTask(h);
    const params = { taskId, _meta: tasksCapableMeta() };

    const denied = await h.gateway.cancelTask({ organizationId: org, params });
    expect(denied).toEqual({
      type: "error",
      error: {
        code: MCP_TASK_OPERATION_FORBIDDEN,
        message: "Task operation is not permitted: tasks/cancel",
        data: { code: "cancel_not_permitted" },
      },
    });

    decision = "accepted";
    const accepted = await h.gateway.cancelTask({ organizationId: org, params });
    expect(accepted).toEqual({ type: "result", result: { resultType: "complete" } });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      organizationId: org,
      actionRequestId: "action-request:1",
      requestedBy: { actor: mcpContext().actor },
    });

    // cooperative cancellationがActionRequestへ反映されたらcancelledとして観測できる。
    h.setView("action-request:1", { status: "cancelled" });
    const polled = await h.getTask(taskId);
    assert(polled.type === "result");
    expect(polled.result.status).toBe("cancelled");
  });

  it("canceller未設定ではtasks/cancelを受理しない", async () => {
    const h = harness();
    const taskId = await pendingTask(h);

    const result = await h.gateway.cancelTask({
      organizationId: org,
      params: { taskId, _meta: tasksCapableMeta() },
    });

    expect(result).toMatchObject({
      type: "error",
      error: { code: MCP_TASK_OPERATION_FORBIDDEN, data: { code: "cancellation_not_supported" } },
    });
  });
});
