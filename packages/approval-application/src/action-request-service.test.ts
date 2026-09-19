import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vite-plus/test";

import {
  always,
  approve,
  authorityPrincipal,
  definePolicy,
  principal,
  rule,
} from "@app/approval-core";
import type {
  ActionDefinition,
  ActionDefinitionKey,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionRequest,
  ActionRequestId,
  ActionType,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ExecutorKey,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  ResourceId,
  ResourceType,
  SchemaKey,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";

import {
  ActionRequestApplicationService,
  HttpTrustedContextError,
  createActionRequestHttpApi,
} from "./index.ts";
import type {
  ActionWorkflowStarter,
  HttpTrustedContextProvider,
  VersionedPolicyBindingResolver,
} from "./index.ts";

function brand<T extends string>(value: string): T {
  return value as T;
}

const organizationId = brand<OrganizationId>("org:m6");
const trustedUserId = brand<UserId>("user:trusted");
const actionType = brand<ActionType>("ticket.priority.change");
const resourceType = brand<ResourceType>("ticket");
const resourceId = brand<ResourceId>("TICKET-123");

function standardSchema(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "m6-test",
      validate(value: unknown) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return { value: value as Record<string, unknown> };
        }
        return { issues: [{ message: "input must be object" }] };
      },
    },
  };
}

function definition(): ActionDefinition {
  return {
    key: brand<ActionDefinitionKey>("ticket-priority-change"),
    version: 1,
    actionType,
    inputSchema: { key: brand<SchemaKey>("ticket-priority-input"), version: 1 },
    executorKey: brand<ExecutorKey>("ticket-priority-executor"),
  };
}

function approvalSource(): VersionedApprovalPolicyBinding {
  const policyKey = brand<ApprovalPolicyKey>("policy:critical");
  const binding: ApprovalPolicyBinding = {
    id: brand<ApprovalPolicyBindingId>("binding:critical"),
    organizationId,
    policyKey,
    selector: { actionTypes: [actionType] },
    enabled: true,
  };
  return {
    binding,
    policyVersion: 1,
    policy: definePolicy({
      key: String(policyKey),
      name: "Critical ticket",
      rules: [
        rule("default", {
          when: always(),
          flow: approve({
            key: "manager",
            approver: principal(authorityPrincipal()),
          }),
        }),
      ],
    }),
  };
}

class SequenceIdGenerator {
  private nextValue = 0;
  next(): ActionRequestId {
    this.nextValue += 1;
    return brand<ActionRequestId>(`action-request:m6-${this.nextValue}`);
  }
}

class CapturingPlanRepository implements MaterializedPlanRepository {
  readonly plans: MaterializedApprovalPlan[] = [];
  async save(plan: MaterializedApprovalPlan) {
    this.plans.push(plan);
    return { type: "created" as const };
  }
  async load() {
    return { type: "not_found" as const };
  }
}

class CapturingWorkflowStarter implements ActionWorkflowStarter {
  readonly plans: MaterializedApprovalPlan[] = [];
  async start(input: { plan: MaterializedApprovalPlan; startedAt: string }) {
    this.plans.push(input.plan);
    return Result.succeed({ workflowInstanceId: String(input.plan.actionRequestId) });
  }
}

class CapturingExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  readonly requests: ActionExecutionRequest[] = [];
  async execute(request: ActionExecutionRequest) {
    this.requests.push(request);
    const result: ActionExecutionResult = {
      status: "succeeded",
      output: { priority: "critical" },
    };
    return Result.succeed(result);
  }
}

function authorizer(mode: "allow" | "deny") {
  return {
    async check(input: {
      request: ActionRequest;
      evaluatedAt: string;
      consistency: "minimize_latency" | "higher_consistency";
    }) {
      if (mode === "deny") {
        return Result.succeed({
          type: "deny" as const,
          code: "forbidden_action",
          reason: "authority may not execute this action",
        });
      }
      return Result.succeed({
        type: "allow" as const,
        evidence: {
          provider: "m6-test",
          evaluatedAt: input.evaluatedAt,
          consistency: input.consistency,
        },
      });
    },
  };
}

function policyResolver(
  sources: readonly VersionedApprovalPolicyBinding[],
): VersionedPolicyBindingResolver {
  return {
    async resolve() {
      return Result.succeed(sources);
    },
  };
}

function service(input: {
  mode?: "allow" | "deny";
  policies?: readonly VersionedApprovalPolicyBinding[];
}) {
  const plans = new CapturingPlanRepository();
  const workflows = new CapturingWorkflowStarter();
  const executor = new CapturingExecutor();
  const application = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: () => definition() },
    schemaResolver: { resolve: () => standardSchema() },
    policyBindingResolver: policyResolver(input.policies ?? []),
    authorizer: authorizer(input.mode ?? "allow"),
    executor,
    planRepository: plans,
    workflowStarter: workflows,
    idGenerator: new SequenceIdGenerator(),
  });
  return { application, plans, workflows, executor };
}

function trustedContextProvider(): HttpTrustedContextProvider {
  return {
    async resolve(input) {
      if (String(input.organizationId) !== String(organizationId)) {
        return Result.fail(new HttpTrustedContextError(403, "tenant_forbidden", "tenant forbidden"));
      }
      return Result.succeed({
        actor: { type: "user", id: trustedUserId },
        authority: { principal: { type: "user", id: trustedUserId } },
        origin: { type: "api" },
        organization: { id: organizationId },
        now: "2026-09-19T00:00:00.000Z",
      });
    },
  };
}

function requestBody(extra: Record<string, unknown> = {}) {
  return {
    action: {
      type: String(actionType),
      resource: { type: String(resourceType), id: String(resourceId) },
      input: { priority: "critical" },
    },
    ...extra,
  };
}

function post(body: unknown): Request {
  return new Request(
    `https://example.test/v1/organizations/${encodeURIComponent(String(organizationId))}/action-requests`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-ticket-priority-1",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("M6-1 ActionRequest unified entrypoint", () => {
  it("AC-M6-001: same POST decides immediate execution vs pending approval internally", async () => {
    const noApproval = service({});
    const noApprovalApi = createActionRequestHttpApi({
      service: noApproval.application,
      trustedContextProvider: trustedContextProvider(),
    });
    const executed = await noApprovalApi.fetch(post(requestBody()));
    expect(executed.status).toBe(201);
    expect(await executed.json()).toMatchObject({
      status: "executed",
      approval: { required: false },
    });
    expect(noApproval.executor.requests).toHaveLength(1);
    expect(noApproval.workflows.plans).toHaveLength(0);

    const requiresApproval = service({ policies: [approvalSource()] });
    const approvalApi = createActionRequestHttpApi({
      service: requiresApproval.application,
      trustedContextProvider: trustedContextProvider(),
    });
    const pending = await approvalApi.fetch(post(requestBody()));
    expect(pending.status).toBe(201);
    expect(await pending.json()).toMatchObject({
      status: "pending_approval",
      approval: { required: true },
    });
    expect(requiresApproval.executor.requests).toHaveLength(0);
    expect(requiresApproval.workflows.plans).toHaveLength(1);
  });

  it("AC-M6-002: actor/authority cannot be supplied from the public body", async () => {
    const fixture = service({});
    const api = createActionRequestHttpApi({
      service: fixture.application,
      trustedContextProvider: trustedContextProvider(),
    });
    const spoofAttempt = await api.fetch(
      post(
        requestBody({
          actor: { type: "user", id: "user:spoofed" },
          authority: { principal: { type: "user", id: "user:spoofed" } },
        }),
      ),
    );
    expect(spoofAttempt.status).toBe(400);
    expect(fixture.plans.plans).toHaveLength(0);

    const accepted = await api.fetch(post(requestBody()));
    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as {
      actor: { id: string };
      authorityPrincipal: { id: string };
    };
    expect(body.actor.id).toBe(String(trustedUserId));
    expect(body.authorityPrincipal.id).toBe(String(trustedUserId));
  });

  it("AC-M6-003: authorization deny is 403 and creates no plan/workflow/execution", async () => {
    const fixture = service({ mode: "deny", policies: [approvalSource()] });
    const api = createActionRequestHttpApi({
      service: fixture.application,
      trustedContextProvider: trustedContextProvider(),
    });
    const response = await api.fetch(post(requestBody()));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      status: 403,
      code: "forbidden_action",
    });
    expect(fixture.plans.plans).toHaveLength(0);
    expect(fixture.workflows.plans).toHaveLength(0);
    expect(fixture.executor.requests).toHaveLength(0);
  });
});
