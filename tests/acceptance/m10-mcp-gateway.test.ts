import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import { assert, describe, expect, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  always,
  approve,
  definePolicy,
  eq,
  executeActionRequest,
  field,
  literal,
  managerOf,
  authorityPrincipal,
  MemoryTelemetrySink,
  none,
  rule,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionEventRecord,
  ActionEventRepository,
  ActionRequest,
  ActionRequestId,
  ActionType,
  AgentId,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalTaskId,
  ApproverCandidateList,
  ApproverResolver,
  ApproverResolverProviderError,
  AuthorizationConsistency,
  ClientId,
  ExecutorKey,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  ResolvedApproverTarget,
  ResourceType,
  SchemaKey,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";
import {
  ActionRequestApplicationService,
  ActionRequestDependencyError,
  createActionRequestHttpApi,
} from "@app/approval-application";
import type {
  ActionRequestView,
  ActionWorkflowStarter,
  TrustedActionRequestContext,
  VersionedPolicyBindingResolver,
} from "@app/approval-application";
import {
  InMemoryMcpInvocationRepository,
  InMemoryMcpRouteSnapshotRepository,
  McpActionExecutor,
  McpGateway,
  MCP_INVOCATION_KEY_META_KEY,
  StaticMcpDownstreamServerRegistry,
  StaticMcpToolBindingRegistry,
  StaticMcpToolExposurePolicy,
  tasksCapableMeta,
  type McpDownstreamClient,
  type McpToolBinding,
  type McpToolRelationshipChecker,
} from "@app/approval-mcp";
import type { OpenFgaClient } from "@app/approval-fga";
import { InMemoryApprovalRuntime } from "@app/approval-runtime-memory";

function branded<T extends string>(value: string): T {
  return value as T;
}

const org = branded<OrganizationId>("org:m10");
const alice = branded<UserId>("user:alice");
const bob = branded<UserId>("user:bob");
const assistant = branded<AgentId>("agent:assistant");
const clientId = branded<ClientId>("client:claude");
const actionType = branded<ActionType>("ticket.priority.change");
const ticket = branded<ResourceType>("ticket");
const now = "2026-09-24T09:00:00.000Z";

const schema = {
  "~standard": {
    version: 1,
    vendor: "m10",
    validate(value: unknown) {
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "input must be an object" }] };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

const definition: ActionDefinition = {
  key: branded<ActionDefinitionKey>("ticket-priority-change"),
  version: 1,
  actionType,
  inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
  executorKey: branded<ExecutorKey>("mcp-gateway"),
};

function binding(version: number, mcpServerId: string): McpToolBinding {
  return {
    id: "binding:ticket-priority",
    version,
    organizationId: org,
    status: "active",
    actionType,
    exposedTool: {
      name: "ticket_set_priority",
      description: "Change ticket priority",
      inputSchema: {
        type: "object",
        properties: { ticketId: { type: "string" }, priority: { type: "string" } },
        required: ["ticketId", "priority"],
      },
    },
    target: { mcpServerId, toolName: "set_priority" },
    argumentMapping: { resourceType: ticket, resourceIdArgument: "ticketId" },
  };
}

function agentContext(overrides: Partial<TrustedActionRequestContext> = {}) {
  return {
    actor: { type: "agent", id: assistant },
    authority: {
      principal: { type: "user", id: alice },
      delegation: {
        chain: [
          {
            delegator: { type: "user", id: alice },
            delegatee: { type: "agent", id: assistant },
            grantId: branded("delegation:alice-assistant"),
          },
        ],
      },
    },
    origin: { type: "mcp", clientId, caller: { type: "user", id: alice } },
    organization: { id: org },
    now,
    ...overrides,
  } satisfies TrustedActionRequestContext;
}

class Policies implements VersionedPolicyBindingResolver {
  resolve() {
    const policyKey = branded<ApprovalPolicyKey>("policy:priority");
    const source: VersionedApprovalPolicyBinding = {
      binding: {
        id: branded<ApprovalPolicyBindingId>("binding:priority"),
        organizationId: org,
        policyKey,
        selector: { actionTypes: [actionType] },
        enabled: true,
      },
      policyVersion: 1,
      policy: definePolicy({
        key: String(policyKey),
        name: "priority",
        rules: [
          rule("critical", {
            when: eq(field("action.input.priority"), literal("critical")),
            flow: approve({ key: "manager", approver: managerOf(authorityPrincipal()) }),
          }),
          rule("default", { when: always(), flow: none() }),
        ],
      }),
    };
    return Promise.resolve(Result.succeed([source]));
  }
}

class Resolver implements ApproverResolver {
  check(input: Parameters<ApproverResolver["check"]>[0]) {
    return Promise.resolve(Result.succeed(String(input.userId) === String(bob)));
  }

  list(_input: {
    target: ResolvedApproverTarget;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
    return Promise.resolve(Result.succeed({ userIds: [bob], complete: true }));
  }
}

class Authorizer implements ActionAuthorizer {
  allowed = true;
  calls: AuthorizationConsistency[] = [];

  check(input: Parameters<ActionAuthorizer["check"]>[0]) {
    this.calls.push(input.consistency);
    return Promise.resolve(
      Result.succeed(
        this.allowed
          ? {
              type: "allow" as const,
              evidence: { evaluatedAt: input.evaluatedAt, consistency: input.consistency },
            }
          : { type: "deny" as const, code: "authority_revoked", reason: "revoked" },
      ),
    );
  }
}

class Plans implements MaterializedPlanRepository {
  readonly plans = new Map<string, MaterializedApprovalPlan>();

  save(plan: MaterializedApprovalPlan) {
    if (this.plans.has(String(plan.actionRequestId))) {
      return Promise.resolve({ type: "existing" as const });
    }
    this.plans.set(String(plan.actionRequestId), plan);
    return Promise.resolve({ type: "created" as const });
  }

  load(input: Parameters<MaterializedPlanRepository["load"]>[0]) {
    const plan = this.plans.get(String(input.actionRequestId));
    return Promise.resolve(
      plan ? ({ type: "found", plan } as const) : ({ type: "not_found" } as const),
    );
  }
}

class Events implements ActionEventRepository {
  readonly records: ActionEventRecord[] = [];

  appendMany(records: readonly ActionEventRecord[]) {
    this.records.push(...records);
    return Promise.resolve(Result.succeed(undefined));
  }

  listForAction() {
    return Promise.resolve(Result.succeed(this.records));
  }
}

class Downstream implements McpDownstreamClient {
  calls: Array<Parameters<McpDownstreamClient["callTool"]>[0]> = [];

  callTool(
    input: Parameters<McpDownstreamClient["callTool"]>[0],
  ): ReturnType<McpDownstreamClient["callTool"]> {
    this.calls.push(input);
    return Promise.resolve(
      Result.succeed({
        type: "result" as const,
        result: {
          resultType: "complete" as const,
          content: [{ type: "text" as const, text: `updated via ${input.server.id}` }],
        },
      }),
    );
  }
}

function requestFromPlan(plan: MaterializedApprovalPlan): ActionRequest {
  return {
    actor: plan.evaluationSnapshot.actor,
    authority: plan.evaluationSnapshot.authority,
    origin: plan.evaluationSnapshot.origin,
    action: { type: plan.action.type, resource: plan.action.resource, input: plan.action.input },
  };
}

function createHarness() {
  const authorizer = new Authorizer();
  const plans = new Plans();
  const events = new Events();
  const runtime = new InMemoryApprovalRuntime(new Resolver());
  const routes = new InMemoryMcpRouteSnapshotRepository();
  const invocations = new InMemoryMcpInvocationRepository();
  const downstream = new Downstream();
  const telemetry = new MemoryTelemetrySink();
  const executor = new McpActionExecutor({
    routeSnapshotRepository: routes,
    serverRegistry: new StaticMcpDownstreamServerRegistry([
      { id: "tickets-v1", endpoint: "https://tickets-v1.example/mcp" },
      { id: "tickets-v2", endpoint: "https://tickets-v2.example/mcp" },
    ]),
    client: downstream,
    telemetry,
  });
  let workflowStarts = 0;
  const workflowStarter: ActionWorkflowStarter = {
    async start(input) {
      workflowStarts += 1;
      const started = await runtime.start({ plan: input.plan, startedAt: input.startedAt });
      if (Result.isFailure(started)) {
        return Result.fail(
          new ActionRequestDependencyError("runtime_start_failed", false, started.error.message),
        );
      }
      return Result.succeed({ workflowInstanceId: String(input.plan.actionRequestId) });
    },
  };
  let counter = 0;
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: () => definition },
    schemaResolver: { resolve: () => schema },
    policyBindingResolver: new Policies(),
    authorizer,
    executor,
    planRepository: plans,
    resultRepository: new InMemoryActionAuditStore(),
    eventRepository: events,
    workflowStarter,
    idGenerator: { next: () => branded<ActionRequestId>(`action-request:m10-${++counter}`) },
  });
  const views = new Map<string, ActionRequestView>();
  let context: TrustedActionRequestContext = agentContext();
  let currentBindings = [binding(1, "tickets-v1")];
  const exposure = new StaticMcpToolExposurePolicy([
    { organizationIds: [org], clientIds: [clientId], actionTypes: [actionType] },
  ]);

  function gateway() {
    const registry = StaticMcpToolBindingRegistry.create(currentBindings);
    assert(Result.isSuccess(registry));
    return new McpGateway({
      applicationService: {
        prepare: (input) => service.prepare(input),
        async commit(input) {
          const committed = await service.commit(input);
          if (Result.isSuccess(committed) && committed.value.type === "accepted") {
            views.set(String(committed.value.actionRequestId), committed.value.view);
          }
          return committed;
        },
      },
      bindingRegistry: registry.value,
      exposureAuthorizer: exposure,
      trustedContextProvider: {
        resolve: () => Promise.resolve(Result.succeed(context)),
      },
      invocationRepository: invocations,
      routeSnapshotRepository: routes,
      actionRequestReader: {
        getActionRequest: (input) =>
          Promise.resolve(Result.succeed(views.get(String(input.actionRequestId)) ?? null)),
      },
      clock: { now: () => now },
      telemetry,
    });
  }

  async function callTool(args: Record<string, unknown>, key: string, tasks = true) {
    const meta = { [MCP_INVOCATION_KEY_META_KEY]: key };
    return gateway().callTool({
      organizationId: org,
      params: {
        name: "ticket_set_priority",
        arguments: args,
        _meta: tasks ? tasksCapableMeta(meta) : meta,
      },
    });
  }

  async function getTask(taskId: string) {
    return gateway().getTask({
      organizationId: org,
      params: { taskId, _meta: tasksCapableMeta() },
    });
  }

  /** 承認者のDecision → Workflow相当のRe-Authorization + ActionExecutor実行 → view projection。 */
  async function approve(actionRequestId: string) {
    const state = await runtime.load(branded<ActionRequestId>(actionRequestId));
    assert(Result.isSuccess(state) && state.value);
    const task = state.value.tasks[0];
    assert(task);
    const decided = await runtime.decide({
      actionRequestId: branded<ActionRequestId>(actionRequestId),
      event: {
        idempotencyKey: `decision-${actionRequestId}`,
        taskId: task.id as ApprovalTaskId,
        userId: bob,
        decision: "approve",
        decidedAt: now,
      },
    });
    assert(Result.isSuccess(decided));
    expect(decided.value.state.status).toBe("approved");

    const plan = plans.plans.get(actionRequestId);
    assert(plan);
    const execution = await executeActionRequest({
      authorizer,
      executor,
      organizationId: plan.organizationId,
      actionRequestId: plan.actionRequestId,
      request: requestFromPlan(plan),
      actionFingerprint: plan.actionFingerprint,
      action: plan.action,
      evaluatedAt: now,
    });
    const previous = views.get(actionRequestId);
    assert(previous);
    if (Result.isFailure(execution)) {
      views.set(actionRequestId, {
        ...previous,
        status: "execution_failed",
        result: {
          status: "execution_failed",
          code: "code" in execution.error ? String(execution.error.code) : "unknown",
        },
      });
      return;
    }
    views.set(
      actionRequestId,
      execution.value.type === "executed"
        ? {
            ...previous,
            status: "executed",
            result: { status: "executed", output: execution.value.result.output },
          }
        : {
            ...previous,
            status: "authorization_revoked",
            result: { status: "authorization_revoked", code: execution.value.code },
          },
    );
  }

  const http = createActionRequestHttpApi({
    service,
    trustedContextProvider: {
      resolve: () =>
        Promise.resolve(
          Result.succeed({
            actor: { type: "user" as const, id: alice },
            authority: { principal: { type: "user" as const, id: alice } },
            origin: { type: "api" as const },
            organization: { id: org },
            now,
          }),
        ),
    },
  });

  return {
    authorizer,
    plans,
    events,
    downstream,
    telemetry,
    views,
    gateway,
    callTool,
    getTask,
    approve,
    http,
    workflowStarts: () => workflowStarts,
    setContext(next: TrustedActionRequestContext) {
      context = next;
    },
    publishBindings(next: McpToolBinding[]) {
      currentBindings = next;
    },
  };
}

function taskIdOf(outcome: Awaited<ReturnType<ReturnType<typeof createHarness>["callTool"]>>) {
  assert(outcome.type === "result" && outcome.result.resultType === "task");
  return outcome.result.taskId;
}

const critical = { ticketId: "TICKET-1", priority: "critical" };

describe("M10 MCP Gateway: ActionType連携のtool visibility / approval / downstream execution", () => {
  it("AC-M10-001: tools/listはtrusted principal / client identityに応じてtoolをfilterする", async () => {
    const h = createHarness();

    const visible = await h.gateway().listTools({ organizationId: org });
    h.setContext(agentContext({ origin: { type: "mcp", clientId: branded("client:unknown") } }));
    const hidden = await h.gateway().listTools({ organizationId: org });

    assert(visible.type === "result" && hidden.type === "result");
    expect(visible.result.tools).toEqual([
      {
        name: "ticket_set_priority",
        description: "Change ticket priority",
        inputSchema: binding(1, "tickets-v1").exposedTool.inputSchema,
      },
    ]);
    expect(hidden.result.tools).toEqual([]);
  });

  it("AC-M10-002: exposure=deny / full authorization=allowでもActionRequest / Workflow / Executorを開始しない", async () => {
    const h = createHarness();
    h.setContext(agentContext({ origin: { type: "mcp", clientId: branded("client:unknown") } }));

    const result = await h.callTool(critical, "hidden");

    expect(result).toMatchObject({ type: "error", error: { code: -32602 } });
    expect(h.authorizer.calls).toHaveLength(0);
    expect(h.plans.plans.size).toBe(0);
    expect(h.workflowStarts()).toBe(0);
    expect(h.downstream.calls).toHaveLength(0);
    expect(h.events.records).toHaveLength(0);
  });

  it("AC-M10-003: MCP tools/call → approval → Re-Authorization → downstream MCP tool → Task completed", async () => {
    const h = createHarness();

    const taskId = taskIdOf(await h.callTool(critical, "approve-flow"));
    expect(h.downstream.calls).toHaveLength(0);
    const pending = await h.getTask(taskId);
    assert(pending.type === "result");
    expect(pending.result.status).toBe("working");

    await h.approve("action-request:m10-1");

    expect(h.authorizer.calls).toEqual(["minimize_latency", "higher_consistency"]);
    expect(h.downstream.calls).toHaveLength(1);
    expect(h.downstream.calls[0]).toMatchObject({
      server: { id: "tickets-v1" },
      toolName: "set_priority",
      arguments: { ticketId: "TICKET-1", priority: "critical" },
    });
    const completed = await h.getTask(taskId);
    assert(completed.type === "result");
    expect(completed.result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "updated via tickets-v1" }] },
    });
  });

  it("AC-M10-004: approval待機中のrouting変更で別targetへすり替わらない", async () => {
    const h = createHarness();
    taskIdOf(await h.callTool(critical, "reroute-pending"));

    h.publishBindings([binding(2, "tickets-v2")]);
    await h.approve("action-request:m10-1");
    const fresh = await h.callTool({ ticketId: "TICKET-2", priority: "normal" }, "reroute-new");

    expect(fresh.type).toBe("result");
    expect(h.downstream.calls.map((call) => call.server.id)).toEqual(["tickets-v1", "tickets-v2"]);
  });

  it("AC-M10-005: approval後にauthorityがrevokeされたらdownstreamを実行しない", async () => {
    const h = createHarness();
    const taskId = taskIdOf(await h.callTool(critical, "revoked"));

    h.authorizer.allowed = false;
    await h.approve("action-request:m10-1");

    expect(h.downstream.calls).toHaveLength(0);
    const polled = await h.getTask(taskId);
    assert(polled.type === "result");
    expect(polled.result).toMatchObject({ status: "completed", result: { isError: true } });
  });

  it("AC-M10-006: Tasks非対応clientでは孤立ActionRequest / Workflowを生成しない (#98)", async () => {
    const h = createHarness();

    const result = await h.callTool(critical, "no-tasks", false);

    expect(result).toMatchObject({ type: "error", error: { code: -32021 } });
    expect(h.plans.plans.size).toBe(0);
    expect(h.workflowStarts()).toBe(0);
    expect(h.events.records).toHaveLength(0);
  });

  it("AC-M10-007: 同じlogical invocationの再送は同じActionRequest / Taskへ収束する", async () => {
    const h = createHarness();

    const first = taskIdOf(await h.callTool(critical, "replayed"));
    const second = taskIdOf(await h.callTool(critical, "replayed"));
    const conflict = await h.callTool({ ...critical, priority: "low" }, "replayed");

    expect(second).toBe(first);
    expect(conflict).toMatchObject({ type: "error", error: { code: -32030 } });
    expect(h.plans.plans.size).toBe(1);
    expect(h.workflowStarts()).toBe(1);
  });

  it("AC-M10-008: HTTPとMCPでAuthorization / Approval semanticsを分岐させない", async () => {
    const h = createHarness();

    taskIdOf(await h.callTool(critical, "mcp-semantics"));
    const response = await h.http.fetch(
      new Request("https://test/v1/organizations/org%3Am10/action-requests", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "http-semantics" },
        body: JSON.stringify({
          action: {
            type: actionType,
            resource: { type: ticket, id: "TICKET-1" },
            input: { priority: "critical" },
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    const [mcpPlan, httpPlan] = [...h.plans.plans.values()];
    assert(mcpPlan && httpPlan);
    expect(mcpPlan.flow).toEqual(httpPlan.flow);
    expect(mcpPlan.evaluationSnapshot.origin).toMatchObject({
      type: "mcp",
      clientId: "client:claude",
    });
    expect(httpPlan.evaluationSnapshot.origin).toEqual({ type: "api" });
  });

  it("AC-M10-009: audit / telemetryでMCP invocation → ActionRequest → approval → downstream executionを追跡できる", async () => {
    const h = createHarness();
    taskIdOf(await h.callTool(critical, "traced"));
    await h.approve("action-request:m10-1");

    const received = h.events.records.find((record) => record.event.type === "action.received");
    expect(received?.event).toMatchObject({
      actionRequestId: "action-request:m10-1",
      actor: { type: "agent", id: assistant },
      authority: { type: "user", id: alice },
      caller: { type: "user", id: alice },
      delegationChain: [
        {
          delegator: { type: "user", id: alice },
          delegatee: { type: "agent", id: assistant },
          grantId: "delegation:alice-assistant",
        },
      ],
    });
    const accepted = h.telemetry.records.find(
      (record) => record.kind === "log" && record.event === "request.accepted",
    );
    const executed = h.telemetry.records.find(
      (record) => record.kind === "log" && record.event === "executor.completed",
    );
    expect(accepted).toMatchObject({
      correlation: {
        actionRequestId: "action-request:m10-1",
        mcpInvocationId: expect.any(String),
      },
      attributes: { toolName: "ticket_set_priority", mcpServerId: "tickets-v1" },
    });
    expect(executed).toMatchObject({
      correlation: { actionRequestId: "action-request:m10-1", component: "executor" },
      attributes: { toolName: "ticket_set_priority", mcpServerId: "tickets-v1" },
    });
  });

  it("AC-M10-010: OpenFGA clientをmcp_tool#can_use Exposure checkerとしてそのまま使える", () => {
    const adapt = (client: OpenFgaClient): McpToolRelationshipChecker => client;
    expect(typeof adapt).toBe("function");
  });
});
