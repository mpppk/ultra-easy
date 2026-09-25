import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  always,
  approve,
  authorityPrincipal,
  definePolicy,
  eq,
  field,
  InMemoryFixedWindowRateLimiter,
  literal,
  MemoryTelemetrySink,
  none,
  principal,
  rule,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  ActionType,
  AgentId,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ClientId,
  ExecutorKey,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  MaterializedPlanSaveResult,
  OrganizationId,
  RateLimitPolicy,
  ResourceType,
  SchemaKey,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";
import {
  ActionRequestApplicationService,
  ActionRequestDependencyError,
  type ActionRequestView,
  type ActionWorkflowStarter,
  type TrustedActionRequestContext,
  type VersionedPolicyBindingResolver,
} from "@app/approval-application";

import { McpGatewayError, StaticMcpToolBindingRegistry, type McpToolBinding } from "./binding.ts";
import {
  McpActionExecutor,
  StaticMcpDownstreamServerRegistry,
  type McpDownstreamCallOutcome,
  type McpDownstreamClient,
  McpDownstreamTransportError,
} from "./executor.ts";
import {
  McpExposureProviderError,
  type McpToolExposureAuthorizer,
  type McpToolExposureRequest,
} from "./exposure.ts";
import {
  McpGateway,
  type McpActionRequestCanceller,
  type McpGatewayDependencies,
  type McpTaskAccessAuthorizer,
} from "./gateway.ts";
import type { McpInvocationRepository, McpRouteSnapshotRepository } from "./invocation.ts";
import { InMemoryMcpInvocationRepository, InMemoryMcpRouteSnapshotRepository } from "./memory.ts";
import { MCP_INVOCATION_KEY_META_KEY, tasksCapableMeta, type McpRequestMeta } from "./protocol.ts";

export function branded<T extends string>(value: string): T {
  return value as T;
}

export const org = branded<OrganizationId>("org:gateway");
export const otherOrg = branded<OrganizationId>("org:other");
export const alice = branded<UserId>("user:alice");
export const mallory = branded<UserId>("user:mallory");
export const agent = branded<AgentId>("agent:assistant");
export const clientId = branded<ClientId>("client:claude");
export const priorityActionType = branded<ActionType>("ticket.priority.change");
export const closeActionType = branded<ActionType>("ticket.close");
export const ticket = branded<ResourceType>("ticket");
export const MCP_EXECUTOR_KEY = branded<ExecutorKey>("mcp-gateway");
export const T0 = "2026-09-24T00:00:00.000Z";

export function priorityBinding(overrides: Partial<McpToolBinding> = {}): McpToolBinding {
  return {
    id: "binding:ticket-priority",
    version: 1,
    organizationId: org,
    status: "active",
    actionType: priorityActionType,
    exposedTool: {
      name: "ticket_set_priority",
      description: "Change the priority of a ticket (may require approval)",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "critical"] },
        },
        required: ["ticketId", "priority"],
      },
    },
    target: { mcpServerId: "ticket-server", toolName: "set_priority" },
    argumentMapping: { resourceType: ticket, resourceIdArgument: "ticketId" },
    ...overrides,
  };
}

export function closeBinding(overrides: Partial<McpToolBinding> = {}): McpToolBinding {
  return {
    id: "binding:ticket-close",
    version: 1,
    organizationId: org,
    status: "active",
    actionType: closeActionType,
    exposedTool: {
      name: "ticket_close",
      description: "Close a ticket",
      inputSchema: {
        type: "object",
        properties: { ticketId: { type: "string" } },
        required: ["ticketId"],
      },
    },
    target: { mcpServerId: "ticket-server", toolName: "close" },
    argumentMapping: { resourceType: ticket, resourceIdArgument: "ticketId" },
    ...overrides,
  };
}

const schema = {
  "~standard": {
    version: 1,
    vendor: "mcp-gateway-test",
    validate(value: unknown) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { issues: [{ message: "input must be an object" }] };
      }
      const priority = (value as Record<string, unknown>).priority;
      if (priority !== undefined && typeof priority !== "string") {
        return { issues: [{ message: "priority must be a string", path: ["priority"] }] };
      }
      return { value: value as Record<string, unknown> };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

function definition(actionType: ActionType): ActionDefinition {
  return {
    key: branded<ActionDefinitionKey>(`definition:${String(actionType)}`),
    version: 1,
    actionType,
    inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
    executorKey: MCP_EXECUTOR_KEY,
  };
}

export function mcpContext(
  overrides: Partial<TrustedActionRequestContext> = {},
): TrustedActionRequestContext {
  return {
    actor: { type: "agent", id: agent },
    authority: {
      principal: { type: "user", id: alice },
      delegation: {
        chain: [
          {
            delegator: { type: "user", id: alice },
            delegatee: { type: "agent", id: agent },
            grantId: branded("delegation:alice-assistant"),
          },
        ],
      },
    },
    origin: { type: "mcp", clientId, caller: { type: "user", id: alice } },
    organization: { id: org },
    now: T0,
    ...overrides,
  };
}

/** priority=criticalならauthority principalのapproval、それ以外はnone。 */
export class PriorityPolicies implements VersionedPolicyBindingResolver {
  calls = 0;
  approvalForAll = false;

  resolve(input: Parameters<VersionedPolicyBindingResolver["resolve"]>[0]) {
    this.calls += 1;
    const policyKey = branded<ApprovalPolicyKey>("policy:priority");
    const approval = approve({ key: "owner", approver: principal(authorityPrincipal()) });
    const source: VersionedApprovalPolicyBinding = {
      binding: {
        id: branded<ApprovalPolicyBindingId>("binding:priority"),
        organizationId: input.context.organization.id,
        policyKey,
        selector: { actionTypes: [input.actionDefinition.actionType] },
        enabled: true,
      },
      policyVersion: 1,
      policy: definePolicy({
        key: String(policyKey),
        name: "priority",
        rules: this.approvalForAll
          ? [rule("all", { when: always(), flow: approval })]
          : [
              rule("critical", {
                when: eq(field("action.input.priority"), literal("critical")),
                flow: approval,
              }),
              rule("default", { when: always(), flow: none() }),
            ],
      }),
    };
    return Promise.resolve(Result.succeed([source]));
  }
}

export class MutableAuthorizer implements ActionAuthorizer {
  allowed = true;
  calls: Array<Parameters<ActionAuthorizer["check"]>[0]> = [];

  check(input: Parameters<ActionAuthorizer["check"]>[0]) {
    this.calls.push(input);
    return Promise.resolve(
      Result.succeed(
        this.allowed
          ? {
              type: "allow" as const,
              evidence: {
                evaluatedAt: input.evaluatedAt,
                consistency: input.consistency,
                provider: "gateway-test",
              },
            }
          : { type: "deny" as const, code: "fga_check_denied", reason: "not allowed" },
      ),
    );
  }
}

/** D1と同じく、同じActionRequestの同一Planはexisting、それ以外はcreatedを返す。 */
export class PlanRepository implements MaterializedPlanRepository {
  readonly plans = new Map<string, MaterializedApprovalPlan>();

  save(plan: MaterializedApprovalPlan): Promise<MaterializedPlanSaveResult> {
    const existing = this.plans.get(String(plan.actionRequestId));
    if (existing) {
      return Promise.resolve(
        String(existing.approvalBindingFingerprint) === String(plan.approvalBindingFingerprint)
          ? { type: "existing" }
          : { type: "conflict", existingApprovalPlanChecksum: existing.approvalPlanChecksum },
      );
    }
    this.plans.set(String(plan.actionRequestId), plan);
    return Promise.resolve({ type: "created" });
  }

  load(input: Parameters<MaterializedPlanRepository["load"]>[0]) {
    const plan = this.plans.get(String(input.actionRequestId));
    return Promise.resolve(
      plan ? ({ type: "found", plan } as const) : ({ type: "not_found" } as const),
    );
  }
}

export class WorkflowStarter implements ActionWorkflowStarter {
  starts: MaterializedApprovalPlan[] = [];
  failures = 0;
  retriable = true;

  start(input: { plan: MaterializedApprovalPlan; startedAt: string }) {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.resolve(
        Result.fail(
          new ActionRequestDependencyError("workflow_start_failed", this.retriable, "unavailable"),
        ),
      );
    }
    this.starts.push(input.plan);
    return Promise.resolve(
      Result.succeed({ workflowInstanceId: `workflow:${String(input.plan.actionRequestId)}` }),
    );
  }
}

export class FakeDownstream implements McpDownstreamClient {
  calls: Array<Parameters<McpDownstreamClient["callTool"]>[0]> = [];
  outcome: Result.Result<McpDownstreamCallOutcome, McpDownstreamTransportError> = Result.succeed({
    type: "result",
    result: {
      resultType: "complete",
      content: [{ type: "text", text: "priority updated" }],
      structuredContent: { ok: true },
    },
  });

  callTool(input: Parameters<McpDownstreamClient["callTool"]>[0]) {
    this.calls.push(structuredClone(input));
    return Promise.resolve(this.outcome);
  }
}

export class FakeExposure implements McpToolExposureAuthorizer {
  denied = new Set<string>();
  failing = false;
  calls: McpToolExposureRequest[] = [];

  check(input: McpToolExposureRequest) {
    this.calls.push(input);
    if (this.failing) {
      return Promise.resolve(
        Result.fail(new McpExposureProviderError("fga_unavailable", true, "exposure down")),
      );
    }
    const denied =
      this.denied.has(String(input.actionType)) ||
      this.denied.has(
        `${input.authority.principal.type}:${String(input.authority.principal.id)}`,
      ) ||
      (input.origin.clientId !== undefined && this.denied.has(String(input.origin.clientId)));
    return Promise.resolve(
      Result.succeed(
        denied ? { type: "deny" as const, code: "denied" } : { type: "allow" as const },
      ),
    );
  }
}

export function createGatewayHarness(
  options: {
    bindings?: McpToolBinding[];
    rateLimitPolicy?: RateLimitPolicy;
    taskAccessAuthorizer?: McpTaskAccessAuthorizer;
    canceller?: McpActionRequestCanceller;
    invocationRepository?: (inner: InMemoryMcpInvocationRepository) => McpInvocationRepository;
    routeSnapshotRepository?: McpRouteSnapshotRepository;
    listPageSize?: number;
  } = {},
) {
  const authorizer = new MutableAuthorizer();
  const policies = new PriorityPolicies();
  const plans = new PlanRepository();
  const workflows = new WorkflowStarter();
  const downstream = new FakeDownstream();
  const routes = options.routeSnapshotRepository ?? new InMemoryMcpRouteSnapshotRepository();
  const invocations = new InMemoryMcpInvocationRepository();
  const exposure = new FakeExposure();
  const telemetry = new MemoryTelemetrySink();
  const executor = new McpActionExecutor({
    routeSnapshotRepository: routes,
    serverRegistry: new StaticMcpDownstreamServerRegistry([
      { id: "ticket-server", endpoint: "https://tickets.example/mcp" },
    ]),
    client: downstream,
    telemetry,
  });
  let actionRequestCounter = 0;
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: (type) => definition(type) },
    schemaResolver: { resolve: () => schema },
    policyBindingResolver: policies,
    authorizer,
    executor,
    planRepository: plans,
    resultRepository: new InMemoryActionAuditStore(),
    workflowStarter: workflows,
    idGenerator: {
      next: () => branded<ActionRequestId>(`action-request:${++actionRequestCounter}`),
    },
  });

  const views = new Map<string, ActionRequestView>();
  const prepareCalls: number[] = [];
  const applicationService: McpGatewayDependencies["applicationService"] = {
    prepare(input) {
      prepareCalls.push(1);
      return service.prepare(input);
    },
    async commit(input) {
      const committed = await service.commit(input);
      if (Result.isSuccess(committed) && committed.value.type === "accepted") {
        views.set(String(committed.value.actionRequestId), committed.value.view);
      }
      return committed;
    },
  };

  let context = mcpContext();
  let now = T0;
  let idCounter = 0;
  const registry = StaticMcpToolBindingRegistry.create(
    options.bindings ?? [priorityBinding(), closeBinding()],
  );
  if (Result.isFailure(registry)) return registry;

  const gateway = new McpGateway({
    applicationService,
    bindingRegistry: registry.value,
    exposureAuthorizer: exposure,
    trustedContextProvider: {
      resolve(input) {
        return Promise.resolve(
          String(input.organizationId) === String(context.organization.id)
            ? Result.succeed({ ...context, now })
            : Result.fail(new McpGatewayError("unauthenticated", false, "organization mismatch")),
        );
      },
    },
    invocationRepository: options.invocationRepository?.(invocations) ?? invocations,
    routeSnapshotRepository: routes,
    actionRequestReader: {
      getActionRequest(input) {
        return Promise.resolve(Result.succeed(views.get(String(input.actionRequestId)) ?? null));
      },
    },
    idGenerator: { next: () => `id-${++idCounter}` },
    clock: { now: () => now },
    pollIntervalMs: 2000,
    leaseMs: 30_000,
    telemetry,
    ...(options.listPageSize !== undefined ? { listPageSize: options.listPageSize } : {}),
    ...(options.rateLimitPolicy
      ? {
          rateLimiter: new InMemoryFixedWindowRateLimiter(),
          rateLimitPolicy: options.rateLimitPolicy,
        }
      : {}),
    ...(options.taskAccessAuthorizer ? { taskAccessAuthorizer: options.taskAccessAuthorizer } : {}),
    ...(options.canceller ? { canceller: options.canceller } : {}),
  });

  function call(
    args: Record<string, unknown>,
    input: { key?: string; tasks?: boolean; name?: string; organizationId?: OrganizationId } = {},
  ) {
    const meta: McpRequestMeta = input.key ? { [MCP_INVOCATION_KEY_META_KEY]: input.key } : {};
    return gateway.callTool({
      organizationId: input.organizationId ?? org,
      params: {
        name: input.name ?? "ticket_set_priority",
        arguments: args,
        _meta: input.tasks === false ? meta : tasksCapableMeta(meta),
      },
    });
  }

  function getTask(taskId: string, tasks = true) {
    return gateway.getTask({
      organizationId: org,
      params: { taskId, ...(tasks ? { _meta: tasksCapableMeta() } : {}) },
    });
  }

  return Result.succeed({
    gateway,
    service,
    authorizer,
    policies,
    plans,
    workflows,
    downstream,
    routes,
    invocations,
    exposure,
    telemetry,
    views,
    prepareCalls,
    call,
    getTask,
    setContext(next: TrustedActionRequestContext) {
      context = next;
    },
    advance(ms: number) {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
    setView(actionRequestId: string, patch: Partial<ActionRequestView>) {
      const current = views.get(actionRequestId);
      if (current) views.set(actionRequestId, { ...current, ...patch });
    },
  });
}

export type GatewayHarness = Extract<
  ReturnType<typeof createGatewayHarness>,
  { type: "Success" }
>["value"];
