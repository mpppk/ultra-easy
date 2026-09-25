import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import { describe, expect, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  AuthorizationProviderError,
  always,
  approve,
  authorityPrincipal,
  definePolicy,
  principal,
  rule,
} from "@app/approval-core";
import type {
  Action,
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionExecutionRequest,
  ActionExecutor,
  ActionRequestId,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ExecutorKey,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  SchemaKey,
  SchemaResolver,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";

import {
  ActionRequestApplicationService,
  ActionRequestSimulationService,
  createActionRequestSimulationHttpApi,
} from "./index.ts";
import type {
  ActionWorkflowStarter,
  HttpTrustedContextProvider,
  TrustedActionRequestContext,
  VersionedPolicyBindingResolver,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:m6-sim");
const alice = branded<UserId>("user:alice");
const actionRequestId = branded<ActionRequestId>("simulation:m6");
const action: Action = {
  type: branded("ticket.priority.change"),
  resource: { type: branded("ticket"), id: branded("TICKET-1") },
  input: { priority: "critical" },
};

const trustedContext: TrustedActionRequestContext = {
  actor: { type: "user", id: alice },
  authority: { principal: { type: "user", id: alice } },
  origin: { type: "api" },
  organization: { id: organizationId },
  now: "2026-09-19T00:00:00.000Z",
};

const schema = {
  "~standard": {
    version: 1,
    vendor: "m6-simulator-test",
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
  actionType: action.type,
  inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
  executorKey: branded<ExecutorKey>("ticket-executor"),
};

function approvalBinding(): VersionedApprovalPolicyBinding {
  const policyKey = branded<ApprovalPolicyKey>("policy:m6-simulator");
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>("binding:m6-simulator"),
    organizationId,
    policyKey,
    selector: { actionTypes: [action.type] },
    enabled: true,
  };
  return {
    binding,
    policyVersion: 3,
    policy: definePolicy({
      key: String(policyKey),
      name: "Simulator policy",
      rules: [
        rule("critical", {
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

class FakeAuthorizer implements ActionAuthorizer {
  calls = 0;

  constructor(private readonly mode: "allow" | "deny" | "error") {}

  check(input: Parameters<ActionAuthorizer["check"]>[0]) {
    this.calls += 1;
    if (this.mode === "error") {
      return Promise.resolve(
        Result.fail(
          new AuthorizationProviderError({
            provider: "simulator-test",
            code: "provider_timeout",
            retriable: true,
            detail: "provider unavailable",
          }),
        ),
      );
    }
    if (this.mode === "deny") {
      return Promise.resolve(
        Result.succeed({
          type: "deny" as const,
          code: "action_not_allowed",
          reason: "authority is not allowed",
        }),
      );
    }
    return Promise.resolve(
      Result.succeed({
        type: "allow" as const,
        evidence: {
          evaluatedAt: input.evaluatedAt,
          consistency: input.consistency,
          provider: "simulator-test",
        },
      }),
    );
  }
}

class CountingExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  readonly calls: ActionExecutionRequest[] = [];

  execute(request: ActionExecutionRequest) {
    this.calls.push(request);
    return Promise.resolve(Result.succeed({ status: "succeeded" as const }));
  }
}

class CountingPlanRepository implements MaterializedPlanRepository {
  saves = 0;

  save(_plan: MaterializedApprovalPlan) {
    this.saves += 1;
    return Promise.resolve({ type: "created" as const });
  }

  load() {
    return Promise.resolve({ type: "not_found" as const });
  }
}

class CountingWorkflowStarter implements ActionWorkflowStarter {
  starts = 0;

  start(input: { plan: MaterializedApprovalPlan; startedAt: string }) {
    this.starts += 1;
    return Promise.resolve(
      Result.succeed({ workflowInstanceId: String(input.plan.actionRequestId) }),
    );
  }
}

class StaticPolicyResolver implements VersionedPolicyBindingResolver {
  calls = 0;

  constructor(private readonly bindings: readonly VersionedApprovalPolicyBinding[]) {}

  resolve() {
    this.calls += 1;
    return Promise.resolve(Result.succeed(this.bindings));
  }
}

function harness(
  input: {
    authorization?: "allow" | "deny" | "error";
    approval?: boolean;
  } = {},
) {
  const authorizer = new FakeAuthorizer(input.authorization ?? "allow");
  const executor = new CountingExecutor();
  const planRepository = new CountingPlanRepository();
  const workflowStarter = new CountingWorkflowStarter();
  const policyBindingResolver = new StaticPolicyResolver(input.approval ? [approvalBinding()] : []);
  const schemaResolver: SchemaResolver = { resolve: async () => Result.succeed(schema) };
  const application = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: async () => Result.succeed(definition) },
    schemaResolver,
    policyBindingResolver,
    authorizer,
    executor,
    planRepository,
    resultRepository: new InMemoryActionAuditStore(),
    workflowStarter,
    idGenerator: { next: () => actionRequestId },
  });
  const simulator = new ActionRequestSimulationService(application);
  const trustedContextProvider: HttpTrustedContextProvider = {
    resolve() {
      return Promise.resolve(Result.succeed(trustedContext));
    },
  };
  const api = createActionRequestSimulationHttpApi({ simulator, trustedContextProvider });
  return {
    api,
    authorizer,
    executor,
    planRepository,
    workflowStarter,
    policyBindingResolver,
  };
}

function request(): Request {
  return new Request(
    "https://approval.test/v1/organizations/org%3Am6-sim/action-requests/simulate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
}

function expectNoExecutionSideEffects(value: ReturnType<typeof harness>) {
  expect(value.planRepository.saves).toBe(0);
  expect(value.workflowStarter.starts).toBe(0);
  expect(value.executor.calls).toHaveLength(0);
}

describe("M6-3 ActionRequest Simulator", () => {
  it("AC-M6-010: Authorization/Policy/Approval Planを返すが永続化・Workflow・Executorを呼ばない", async () => {
    const value = harness({ approval: true });

    const response = await value.api.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization: { outcome: "allow" },
      applicablePolicies: [
        {
          bindingId: "binding:m6-simulator",
          policyKey: "policy:m6-simulator",
          policyVersion: 3,
          matchedRuleKey: "critical",
          outcome: "flow",
        },
      ],
      approvalPlan: {
        required: true,
        stepCount: 1,
        flow: { type: "approval", key: "manager" },
      },
    });
    expect(value.authorizer.calls).toBe(1);
    expect(value.policyBindingResolver.calls).toBe(1);
    expectNoExecutionSideEffects(value);
  });

  it("AC-M6-010: approval不要も実行せずnone planとして説明する", async () => {
    const value = harness();

    const response = await value.api.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization: { outcome: "allow" },
      applicablePolicies: [],
      approvalPlan: {
        required: false,
        stepCount: 0,
        flow: { type: "none" },
      },
    });
    expectNoExecutionSideEffects(value);
  });

  it("AC-M6-010: Authorization denyは200のsimulation結果で返しPolicy/side effectへ進まない", async () => {
    const value = harness({ authorization: "deny", approval: true });

    const response = await value.api.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authorization: {
        outcome: "deny",
        code: "action_not_allowed",
        reason: "authority is not allowed",
      },
      applicablePolicies: [],
      approvalPlan: null,
    });
    expect(value.policyBindingResolver.calls).toBe(0);
    expectNoExecutionSideEffects(value);
  });

  it("AC-M6-010: Authorization provider errorも実行せずdiagnostic resultとして返す", async () => {
    const value = harness({ authorization: "error", approval: true });

    const response = await value.api.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        outcome: "error",
        code: "authorization_provider_failed",
      },
      applicablePolicies: [],
      approvalPlan: null,
    });
    expect(value.policyBindingResolver.calls).toBe(0);
    expectNoExecutionSideEffects(value);
  });
});
