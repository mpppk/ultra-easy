import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import { assert, describe, expect, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  ActionApprovalBindingMismatchError,
  approve,
  always,
  authorityPrincipal,
  caller,
  definePolicy,
  eq,
  executeActionRequest,
  field,
  literal,
  managerOf,
  none,
  parallelQuorum,
  principal,
  principalRelation,
  rule,
  serial,
  user,
  validateApprovalBindingForExecution,
} from "@app/approval-core";
import type {
  Action,
  AgentId,
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionExecutionRequest,
  ActionExecutor,
  ActionRequest,
  ActionRequestId,
  ActionType,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalRuntimeState,
  ApprovalTaskId,
  ApproverCandidateList,
  ApproverResolver,
  ApproverResolverProviderError,
  AuthorizationConsistency,
  ExecutorKey,
  FlowDefinition,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  ResolvedApproverTarget,
  ResourceId,
  ResourceType,
  SchemaKey,
  SchemaResolver,
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
  McpGateway,
  StaticMcpToolBindingRegistry,
  StaticMcpToolExposurePolicy,
  tasksCapableMeta,
} from "@app/approval-mcp";
import { InMemoryApprovalRuntime } from "@app/approval-runtime-memory";

function branded<T extends string>(value: string): T {
  return value as T;
}

const org = branded<OrganizationId>("org:m6-e2e");
const alice = branded<UserId>("user:alice");
const bob = branded<UserId>("user:bob");
const carol = branded<UserId>("user:carol");
const dave = branded<UserId>("user:dave");
const agent = branded<AgentId>("agent:ticket");
const actionType = branded<ActionType>("ticket.priority.change");
const resourceType = branded<ResourceType>("ticket");
const resourceId = branded<ResourceId>("TICKET-1");
const now = "2026-09-19T03:30:00.000Z";

const schema = {
  "~standard": {
    version: 1,
    vendor: "m6-e2e",
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
  executorKey: branded<ExecutorKey>("ticket-executor"),
};

function humanContext(): TrustedActionRequestContext {
  return {
    actor: { type: "user", id: alice },
    authority: { principal: { type: "user", id: alice } },
    origin: { type: "api" },
    organization: { id: org },
    now,
  };
}

function delegatedAgentContext(scope = true): TrustedActionRequestContext {
  return {
    actor: { type: "agent", id: agent },
    authority: {
      principal: { type: "user", id: alice },
      delegation: {
        chain: [
          {
            delegator: { type: "user", id: alice },
            delegatee: { type: "agent", id: agent },
            grantId: branded("delegation:alice-agent"),
            ...(scope
              ? {
                  scope: {
                    actionTypes: [actionType],
                    resourceTypes: [resourceType],
                    resourceIds: [resourceId],
                  },
                }
              : {}),
          },
        ],
      },
    },
    origin: {
      type: "mcp",
      caller: { type: "user", id: alice },
    },
    organization: { id: org },
    now,
  };
}

function action(input: Record<string, unknown>): Action {
  return {
    type: actionType,
    resource: { type: resourceType, id: resourceId },
    input,
  };
}

function source(id: string, flow: FlowDefinition, order = 100): VersionedApprovalPolicyBinding {
  const policyKey = branded<ApprovalPolicyKey>(`policy:${id}`);
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>(`binding:${id}`),
    organizationId: org,
    policyKey,
    selector: { actionTypes: [actionType] },
    compositionOrder: order,
    enabled: true,
  };
  return {
    binding,
    policyVersion: 1,
    policy: definePolicy({
      key: String(policyKey),
      name: id,
      rules: [rule("default", { when: always(), flow })],
    }),
  };
}

const manager = () =>
  approve({
    key: "manager",
    approver: managerOf(authorityPrincipal()),
    purpose: "business_approval",
  });
const callerConsent = () =>
  approve({
    key: "caller-consent",
    approver: principal(caller()),
    purpose: "execution_consent",
    selfApproval: { mode: "allow" },
  });
const callerManager = () =>
  approve({
    key: "caller-manager",
    approver: managerOf(caller()),
    purpose: "business_approval",
  });
const security = () =>
  approve({
    key: "security",
    approver: principalRelation(authorityPrincipal(), "security"),
    purpose: "security_approval",
  });
const quorum = () =>
  parallelQuorum(
    2,
    approve({ key: "q-bob", approver: user(literal(String(bob))) }),
    approve({ key: "q-carol", approver: user(literal(String(carol))) }),
    approve({ key: "q-dave", approver: user(literal(String(dave))) }),
  );

const priorityPolicy = (): VersionedApprovalPolicyBinding => {
  const policyKey = branded<ApprovalPolicyKey>("policy:priority");
  return {
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
          flow: manager(),
        }),
        rule("default", { when: always(), flow: none() }),
      ],
    }),
  };
};

class ScenarioPolicies implements VersionedPolicyBindingResolver {
  resolve(input: Parameters<VersionedPolicyBindingResolver["resolve"]>[0]) {
    const rawScenario = input.context.action.input.scenario;
    const scenario = typeof rawScenario === "string" ? rawScenario : "priority";
    let sources: VersionedApprovalPolicyBinding[];
    switch (scenario) {
      case "none":
        sources = [];
        break;
      case "manager":
        sources = [source("manager", manager())];
        break;
      case "caller":
        sources = [source("caller", callerConsent())];
        break;
      case "caller-manager":
        sources = [source("caller-manager", serial(callerConsent(), callerManager()))];
        break;
      case "caller-manager-only":
        sources = [source("caller-manager-only", callerManager())];
        break;
      case "production":
        sources = [source("production", serial(manager(), security()))];
        break;
      case "quorum":
        sources = [source("quorum", quorum())];
        break;
      case "multi":
        sources = [source("security", security(), 20), source("manager", manager(), 10)];
        break;
      default:
        sources = [priorityPolicy()];
        break;
    }
    return Promise.resolve(Result.succeed(sources));
  }
}

class Resolver implements ApproverResolver {
  check(input: Parameters<ApproverResolver["check"]>[0]) {
    return this.list(input).then((result) =>
      Result.isFailure(result)
        ? result
        : Result.succeed(
            result.value.userIds.some((userId) => String(userId) === String(input.userId)),
          ),
    );
  }

  list(input: {
    target: ResolvedApproverTarget;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
    if (input.target.type === "user") {
      return Promise.resolve(Result.succeed({ userIds: [input.target.userId], complete: true }));
    }
    const relation = String(input.target.relation);
    const users = relation === "security" ? [carol] : [bob];
    return Promise.resolve(Result.succeed({ userIds: users, complete: true }));
  }
}

class MutableAuthorizer implements ActionAuthorizer {
  allowed = true;
  calls: AuthorizationConsistency[] = [];

  check(input: Parameters<ActionAuthorizer["check"]>[0]) {
    this.calls.push(input.consistency);
    return Promise.resolve(
      Result.succeed(
        this.allowed
          ? {
              type: "allow" as const,
              evidence: {
                evaluatedAt: input.evaluatedAt,
                consistency: input.consistency,
                provider: "m6-e2e",
              },
            }
          : {
              type: "deny" as const,
              code: "authority_revoked",
              reason: "authority is not allowed",
            },
      ),
    );
  }
}

class Executor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  calls: ActionExecutionRequest[] = [];

  execute(request: ActionExecutionRequest) {
    this.calls.push(request);
    return Promise.resolve(
      Result.succeed({
        status: "succeeded" as const,
        output: { ok: true, requestId: String(request.actionRequestId) },
      }),
    );
  }
}

class PlanRepository implements MaterializedPlanRepository {
  readonly plans = new Map<string, MaterializedApprovalPlan>();

  save(plan: MaterializedApprovalPlan) {
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

class WorkflowStarter implements ActionWorkflowStarter {
  starts = 0;

  constructor(readonly runtime: InMemoryApprovalRuntime) {}

  async start(input: Parameters<ActionWorkflowStarter["start"]>[0]) {
    this.starts += 1;
    const started = await this.runtime.start({ plan: input.plan, startedAt: input.startedAt });
    if (Result.isFailure(started)) {
      return Result.fail(
        new ActionRequestDependencyError(
          "runtime_start_failed",
          false,
          started.error.message,
          started.error,
        ),
      );
    }
    return Result.succeed({ workflowInstanceId: String(input.plan.actionRequestId) });
  }
}

function requestFromPlan(plan: MaterializedApprovalPlan): ActionRequest {
  return {
    actor: plan.evaluationSnapshot.actor,
    authority: plan.evaluationSnapshot.authority,
    origin: plan.evaluationSnapshot.origin,
    action: {
      type: plan.action.type,
      resource: plan.action.resource,
      input: plan.action.input,
    },
  };
}

function createHarness() {
  const authorizer = new MutableAuthorizer();
  const executor = new Executor();
  const plans = new PlanRepository();
  const runtime = new InMemoryApprovalRuntime(new Resolver());
  const workflows = new WorkflowStarter(runtime);
  let id = 0;
  let currentContext = humanContext();
  const views = new Map<string, ActionRequestView>();

  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: async () => Result.succeed(definition) },
    schemaResolver: { resolve: async () => Result.succeed(schema) } satisfies SchemaResolver,
    policyBindingResolver: new ScenarioPolicies(),
    authorizer,
    executor,
    planRepository: plans,
    eventRepository: new InMemoryActionAuditStore(),
    resultRepository: new InMemoryActionAuditStore(),
    workflowStarter: workflows,
    idGenerator: {
      next: () => branded<ActionRequestId>(`action-request:e2e-${++id}`),
    },
  });

  const capturingService: Pick<ActionRequestApplicationService, "prepare" | "commit"> = {
    prepare: (input) => service.prepare(input),
    async commit(input) {
      const result = await service.commit(input);
      if (Result.isSuccess(result) && result.value.type === "accepted") {
        views.set(String(result.value.actionRequestId), result.value.view);
      }
      return result;
    },
  };

  const http = createActionRequestHttpApi({
    service,
    trustedContextProvider: {
      resolve() {
        return Promise.resolve(Result.succeed(currentContext));
      },
    },
  });

  const registry = StaticMcpToolBindingRegistry.create([
    {
      id: "binding:ticket-priority",
      version: 1,
      organizationId: org,
      status: "active",
      actionType,
      exposedTool: {
        name: "ticket_set_priority",
        inputSchema: {
          type: "object",
          properties: { ticketId: { type: "string" } },
          required: ["ticketId"],
        },
      },
      target: { mcpServerId: "ticket-server", toolName: "set_priority" },
      argumentMapping: { resourceType, resourceIdArgument: "ticketId" },
    },
  ]);
  assert(Result.isSuccess(registry));
  const mcp = new McpGateway({
    applicationService: capturingService,
    bindingRegistry: registry.value,
    exposureAuthorizer: new StaticMcpToolExposurePolicy([{ organizationIds: [org] }]),
    trustedContextProvider: {
      resolve() {
        return Promise.resolve(Result.succeed(currentContext));
      },
    },
    invocationRepository: new InMemoryMcpInvocationRepository(),
    routeSnapshotRepository: new InMemoryMcpRouteSnapshotRepository(),
    actionRequestReader: {
      getActionRequest(input) {
        return Promise.resolve(Result.succeed(views.get(String(input.actionRequestId)) ?? null));
      },
    },
    clock: { now: () => now },
  });

  async function submitHttp(input: Record<string, unknown>, context = humanContext()) {
    currentContext = context;
    const response = await http.fetch(
      new Request("https://test/v1/organizations/org%3Am6-e2e/action-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `idem-${id + 1}`,
        },
        body: JSON.stringify({ action: action(input) }),
      }),
    );
    const body = (await response.json()) as ActionRequestView & { code?: string };
    if (response.status === 201) views.set(body.id, body);
    return { response, body };
  }

  async function submitMcp(input: Record<string, unknown>, context = delegatedAgentContext()) {
    currentContext = context;
    return mcp.callTool({
      organizationId: org,
      params: {
        name: "ticket_set_priority",
        arguments: { ticketId: String(resourceId), ...input },
        _meta: tasksCapableMeta(),
      },
    });
  }

  async function decide(actionRequestId: string, taskIndex: number, userId: UserId) {
    const state = await runtime.load(branded<ActionRequestId>(actionRequestId));
    assert(Result.isSuccess(state));
    assert(state.value);
    const task = state.value.tasks[taskIndex];
    assert(task);

    const decided = await runtime.decide({
      actionRequestId: branded<ActionRequestId>(actionRequestId),
      event: {
        idempotencyKey: `decision-${actionRequestId}-${taskIndex}-${String(userId)}`,
        taskId: task.id as ApprovalTaskId,
        userId,
        decision: "approve",
        decidedAt: now,
      },
    });
    assert(Result.isSuccess(decided));

    if (decided.value.state.status === "approved") {
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
      assert(Result.isSuccess(execution));
      // このfixtureのexecutorは同期executor（acceptedを返さない）。
      assert(execution.value.type !== "accepted");
      const previous = views.get(actionRequestId);
      assert(previous);
      if (execution.value.type === "executed") {
        views.set(actionRequestId, {
          ...previous,
          status: "executed",
          result: { status: "executed", output: execution.value.result.output },
          updatedAt: now,
          completedAt: now,
        });
      } else {
        views.set(actionRequestId, {
          ...previous,
          status: "authorization_revoked",
          result: {
            status: "authorization_revoked",
            code: execution.value.code,
            message: execution.value.reason,
          },
          updatedAt: now,
          completedAt: now,
        });
      }
    }
    return decided.value.state;
  }

  return {
    authorizer,
    executor,
    plans,
    workflows,
    runtime,
    views,
    mcp,
    submitHttp,
    submitMcp,
    decide,
    setContext(context: TrustedActionRequestContext) {
      currentContext = context;
    },
  };
}

function idFromTaskResult(
  result: Awaited<ReturnType<ReturnType<typeof createHarness>["submitMcp"]>>,
) {
  assert(result.type === "result");
  assert(result.result.resultType === "task");
  return result.result.taskId;
}

describe("M6-5 critical path E2E", () => {
  it("01 Human + direct authority + no approval → executed", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ scenario: "none" });
    expect(body.status).toBe("executed");
    expect(h.executor.calls).toHaveLength(1);
  });

  it("02 Human + manager approval → approve → executed", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ scenario: "manager" });
    expect(body.status).toBe("pending_approval");
    await h.decide(body.id, 0, bob);
    expect(h.views.get(body.id)?.status).toBe("executed");
  });

  it("03 AI + delegated authority + no approval → executed", async () => {
    const h = createHarness();
    const result = await h.submitMcp({ scenario: "none" });
    assert(result.type === "result");
    expect(result.result.resultType).toBe("complete");
    expect(h.executor.calls).toHaveLength(1);
  });

  it("04 AI + caller execution consent → approve → executed", async () => {
    const h = createHarness();
    const result = await h.submitMcp({ scenario: "caller" });
    idFromTaskResult(result);
    const plan = [...h.plans.plans.values()][0]!;
    await h.decide(String(plan.actionRequestId), 0, alice);
    expect(h.views.get(String(plan.actionRequestId))?.status).toBe("executed");
  });

  it("05 AI + caller consent + caller manager → serial approvals → executed", async () => {
    const h = createHarness();
    await h.submitMcp({ scenario: "caller-manager" });
    const plan = [...h.plans.plans.values()][0]!;
    const first = await h.decide(String(plan.actionRequestId), 0, alice);
    expect(first.status).toBe("pending");
    const second = await h.decide(String(plan.actionRequestId), 1, bob);
    expect(second.status).toBe("approved");
    expect(h.views.get(String(plan.actionRequestId))?.status).toBe("executed");
  });

  it("06 AI + caller manager only → manager approval → executed", async () => {
    const h = createHarness();
    await h.submitMcp({ scenario: "caller-manager-only" });
    const plan = [...h.plans.plans.values()][0]!;
    await h.decide(String(plan.actionRequestId), 0, bob);
    expect(h.views.get(String(plan.actionRequestId))?.status).toBe("executed");
  });

  it("07 Ticket priority normal → immediate execute", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ priority: "normal" });
    expect(body.status).toBe("executed");
  });

  it("08 Ticket priority critical → manager approval", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ priority: "critical" });
    expect(body.status).toBe("pending_approval");
    await h.decide(body.id, 0, bob);
    expect(h.views.get(body.id)?.status).toBe("executed");
  });

  it("09 production access → manager + security", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ scenario: "production" });
    await h.decide(body.id, 0, bob);
    const state = await h.decide(body.id, 1, carol);
    expect(state.status).toBe("approved");
    expect(h.views.get(body.id)?.status).toBe("executed");
  });

  it("10 quorum 2/3 → 2 approvalsでexecute", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ scenario: "quorum" });
    const first = await h.decide(body.id, 0, bob);
    expect(first.status).toBe("pending");
    const second = await h.decide(body.id, 1, carol);
    expect(second.status).toBe("approved");
    expect(h.views.get(body.id)?.status).toBe("executed");
  });

  it("11 delegated request → delegation scope内のみexecute", async () => {
    const h = createHarness();
    const allowed = await h.submitHttp({ scenario: "none" }, delegatedAgentContext());
    expect(allowed.body.status).toBe("executed");

    const outside = delegatedAgentContext();
    outside.authority.delegation!.chain[0]!.scope = {
      actionTypes: [branded<ActionType>("other.action")],
    };
    const denied = await h.submitHttp({ scenario: "none" }, outside);
    expect(denied.response.status).toBe(403);
  });

  it("12 approval待機中authority revoke → authorization_revoked", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ scenario: "manager" });
    h.authorizer.allowed = false;
    await h.decide(body.id, 0, bob);
    expect(h.views.get(body.id)?.status).toBe("authorization_revoked");
  });

  it("13 approval-sensitive input変更 → old approval再利用不可", async () => {
    const h = createHarness();
    const first = await h.submitHttp({ scenario: "manager", value: 1 });
    await h.decide(first.body.id, 0, bob);
    const oldState = await h.runtime.load(branded<ActionRequestId>(first.body.id));
    assert(Result.isSuccess(oldState));
    assert(oldState.value);

    const second = await h.submitHttp({ scenario: "manager", value: 2 });
    const secondPlan = h.plans.plans.get(second.body.id);
    assert(secondPlan);
    const binding = validateApprovalBindingForExecution({
      plan: secondPlan,
      state: oldState.value as ApprovalRuntimeState,
    });
    assert(Result.isFailure(binding));
    expect(binding.error).toBeInstanceOf(ActionApprovalBindingMismatchError);
  });

  it("14 Policy複数合成 → deterministic serial plan", async () => {
    const h = createHarness();
    const { body } = await h.submitHttp({ scenario: "multi" });
    const plan = h.plans.plans.get(body.id);
    assert(plan);
    expect(plan.flow.type).toBe("serial");
    if (plan.flow.type !== "serial") return;
    expect(
      plan.flow.children.map((child) => (child.type === "approval" ? String(child.stepKey) : "?")),
    ).toEqual(["manager", "security"]);
  });

  it("15 unauthorized AI + human approval attempt → denyのまま", async () => {
    const h = createHarness();
    h.authorizer.allowed = false;
    const result = await h.submitMcp({ scenario: "manager" });
    assert(result.type === "result");
    expect(result.result.resultType).toBe("complete");
    if (result.result.resultType !== "complete") return;
    expect(result.result.isError).toBe(true);
    expect(h.workflows.starts).toBe(0);
    expect(h.executor.calls).toHaveLength(0);
  });
});
