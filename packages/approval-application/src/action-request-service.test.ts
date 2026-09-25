import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import { assert, describe, expect, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  InMemoryFixedWindowRateLimiter,
  MemoryTelemetrySink,
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
  ActionEventRecord,
  ActionEventRepository,
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
  RateLimitPolicy,
  SchemaKey,
  SchemaResolver,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";

import {
  ActionRequestApplicationService,
  createActionRequestHttpApi,
  type ActionWorkflowStarter,
  type HttpTrustedContextProvider,
  type TrustedActionRequestContext,
  type VersionedPolicyBindingResolver,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:m6");
const alice = branded<UserId>("user:alice");
const actionRequestId = branded<ActionRequestId>("action-request:m6");
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
    vendor: "m6-test",
    validate(value: unknown) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return { value: value as Record<string, unknown> };
      }
      return { issues: [{ message: "input must be an object" }] };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

const definition: ActionDefinition = {
  key: branded<ActionDefinitionKey>("ticket-priority-change"),
  version: 1,
  actionType: action.type,
  inputSchema: { key: branded<SchemaKey>("ticket-priority-input"), version: 1 },
  executorKey: branded<ExecutorKey>("ticket-priority-executor"),
};

function approvalPolicy(): VersionedApprovalPolicyBinding {
  const policyKey = branded<ApprovalPolicyKey>("policy:m6");
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>("binding:m6"),
    organizationId,
    policyKey,
    selector: { actionTypes: [action.type] },
    enabled: true,
  };
  return {
    binding,
    policyVersion: 1,
    policy: definePolicy({
      key: "policy:m6",
      name: "M6 approval",
      rules: [
        rule("approve", {
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

  constructor(private readonly allowed: boolean) {}

  check() {
    this.calls += 1;
    return Promise.resolve(
      Result.succeed(
        this.allowed
          ? {
              type: "allow" as const,
              evidence: {
                evaluatedAt: trustedContext.now,
                consistency: "higher_consistency" as const,
                provider: "m6-test",
              },
            }
          : {
              type: "deny" as const,
              code: "action_not_allowed",
              reason: "actor is not authorized",
            },
      ),
    );
  }
}

class FakeExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  calls: ActionExecutionRequest[] = [];

  execute(request: ActionExecutionRequest) {
    this.calls.push(request);
    return Promise.resolve(
      Result.succeed({
        status: "succeeded" as const,
        output: { ok: true },
      }),
    );
  }
}

class FakePlanRepository implements MaterializedPlanRepository {
  saved: MaterializedApprovalPlan[] = [];
  saveResult: "created" | "existing" = "created";

  save(plan: MaterializedApprovalPlan) {
    this.saved.push(plan);
    return Promise.resolve({ type: this.saveResult });
  }

  load() {
    return Promise.resolve({ type: "not_found" as const });
  }
}

class FakeWorkflowStarter implements ActionWorkflowStarter {
  plans: MaterializedApprovalPlan[] = [];

  start(input: { plan: MaterializedApprovalPlan; startedAt: string }) {
    this.plans.push(input.plan);
    return Promise.resolve(
      Result.succeed({ workflowInstanceId: String(input.plan.actionRequestId) }),
    );
  }
}

class FakePolicyResolver implements VersionedPolicyBindingResolver {
  calls = 0;

  constructor(public bindings: readonly VersionedApprovalPolicyBinding[]) {}

  resolve() {
    this.calls += 1;
    return Promise.resolve(Result.succeed(this.bindings));
  }
}

class FakeEventRepository implements ActionEventRepository {
  records: ActionEventRecord[] = [];

  appendMany(records: readonly ActionEventRecord[]) {
    this.records.push(...records);
    return Promise.resolve(Result.succeed(undefined));
  }

  listForAction() {
    return Promise.resolve(Result.succeed(this.records));
  }
}

function createHarness(
  input: {
    allowed?: boolean;
    approvalRequired?: boolean;
    rateLimitPolicy?: RateLimitPolicy;
    telemetry?: MemoryTelemetrySink;
  } = {},
) {
  const authorizer = new FakeAuthorizer(input.allowed ?? true);
  const executor = new FakeExecutor();
  const planRepository = new FakePlanRepository();
  const workflowStarter = new FakeWorkflowStarter();
  const policyBindingResolver = new FakePolicyResolver(
    input.approvalRequired ? [approvalPolicy()] : [],
  );
  const schemaResolver: SchemaResolver = { resolve: () => schema };
  const eventRepository = new FakeEventRepository();
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: () => definition },
    schemaResolver,
    policyBindingResolver,
    authorizer,
    executor,
    planRepository,
    resultRepository: new InMemoryActionAuditStore(),
    eventRepository,
    workflowStarter,
    idGenerator: { next: () => actionRequestId },
  });

  let trustedContextCalls = 0;
  const trustedContextProvider: HttpTrustedContextProvider = {
    resolve() {
      trustedContextCalls += 1;
      return Promise.resolve(Result.succeed(trustedContext));
    },
  };
  const api = createActionRequestHttpApi({
    service,
    trustedContextProvider,
    ...(input.rateLimitPolicy
      ? {
          rateLimiter: new InMemoryFixedWindowRateLimiter(),
          rateLimitPolicy: input.rateLimitPolicy,
        }
      : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
  });

  return {
    api,
    service,
    eventRepository,
    policyBindingResolver,
    authorizer,
    executor,
    planRepository,
    workflowStarter,
    trustedContextCalls: () => trustedContextCalls,
  };
}

function request(body: unknown): Request {
  return new Request("https://approval.test/v1/organizations/org%3Am6/action-requests", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem:m6",
    },
    body: JSON.stringify(body),
  });
}

describe("M6-1 ActionRequest unified entrypoint", () => {
  it("AC-M6-001: callerは同じPOSTだけを使い、Policy結果でimmediate executeになる", async () => {
    const harness = createHarness({ approvalRequired: false });

    const response = await harness.api.fetch(request({ action }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: String(actionRequestId),
      status: "executed",
      approval: { required: false },
      result: { status: "executed", output: { ok: true } },
    });
    expect(harness.planRepository.saved).toHaveLength(1);
    expect(harness.workflowStarter.plans).toHaveLength(0);
    expect(harness.executor.calls).toHaveLength(1);
    expect(harness.authorizer.calls).toBe(2);
  });

  it("AC-M6-001: 同じPOSTがPolicy結果でpending_approvalになりExecutorを呼ばない", async () => {
    const harness = createHarness({ approvalRequired: true });

    const response = await harness.api.fetch(request({ action }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: String(actionRequestId),
      status: "pending_approval",
      approval: { required: true },
    });
    expect(harness.planRepository.saved).toHaveLength(1);
    expect(harness.workflowStarter.plans).toHaveLength(1);
    expect(harness.executor.calls).toHaveLength(0);
    expect(harness.authorizer.calls).toBe(1);
  });

  it("AC-M6-002: actor/authorityをbodyから指定してtrusted contextを偽装できない", async () => {
    const harness = createHarness();

    for (const injected of [
      { actor: { type: "user", id: "user:mallory" } },
      { authority: { principal: { type: "user", id: "user:mallory" } } },
    ]) {
      const response = await harness.api.fetch(request({ action, ...injected }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_action_request",
      });
    }

    expect(harness.trustedContextCalls()).toBe(0);
    expect(harness.authorizer.calls).toBe(0);
    expect(harness.executor.calls).toHaveLength(0);
  });

  it("AC-M6-003: initial Authorization denyは403でTask/Workflow/Executorを作らない", async () => {
    const harness = createHarness({ allowed: false, approvalRequired: true });

    const response = await harness.api.fetch(request({ action }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      status: 403,
      code: "action_not_allowed",
      actionRequestId: String(actionRequestId),
    });
    expect(harness.planRepository.saved).toHaveLength(0);
    expect(harness.workflowStarter.plans).toHaveLength(0);
    expect(harness.executor.calls).toHaveLength(0);
  });

  it("AC-M7-007/009: HTTP logはactionRequestIdで相関しAction inputを含めない", async () => {
    const telemetry = new MemoryTelemetrySink();
    const harness = createHarness({ telemetry });

    const response = await harness.api.fetch(request({ action }));
    expect(response.status).toBe(201);
    expect(telemetry.records).toHaveLength(1);
    expect(telemetry.records[0]).toMatchObject({
      kind: "log",
      event: "request.accepted",
      correlation: {
        organizationId,
        actionRequestId,
        correlationId: String(actionRequestId),
        component: "http",
        operation: "action_request.submit",
      },
      attributes: { status: "executed" },
    });
    expect(JSON.stringify(telemetry.records)).not.toContain("critical");
    expect(JSON.stringify(telemetry.records)).not.toContain('"input"');
  });

  it("AC-M7 rate limit: ActionRequest超過は429とretry metadataを返す", async () => {
    const harness = createHarness({
      rateLimitPolicy: { limit: 1, windowSeconds: 60 },
    });

    const first = await harness.api.fetch(request({ action }));
    const limited = await harness.api.fetch(request({ action }));

    expect(first.status).toBe(201);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
    });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("x-ratelimit-limit")).toBe("1");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
  });
});

describe("MCP Gateway 3: ActionRequest prepare → admission → commit", () => {
  async function prepared(harness: ReturnType<typeof createHarness>) {
    const result = await harness.service.prepare({ action, trustedContext });
    assert(Result.isSuccess(result));
    return result.value;
  }

  it("prepareはPlan保存 / audit / Workflow / Executorの副作用を起こさない", async () => {
    for (const approvalRequired of [true, false]) {
      const harness = createHarness({ approvalRequired });

      const preparation = await prepared(harness);

      expect(preparation).toMatchObject({
        type: "prepared",
        prepared: { actionRequestId, organizationId, approvalRequired },
      });
      expect(harness.planRepository.saved).toHaveLength(0);
      expect(harness.eventRepository.records).toHaveLength(0);
      expect(harness.workflowStarter.plans).toHaveLength(0);
      expect(harness.executor.calls).toHaveLength(0);
    }
  });

  it("commitはprepare済みの同一Planを保存しPolicyを再評価しない", async () => {
    const harness = createHarness({ approvalRequired: true });
    const preparation = await prepared(harness);
    assert(preparation.type === "prepared");

    // admission中にPolicyが変更されても、commit対象Planは変化しない。
    harness.policyBindingResolver.bindings = [];
    const committed = await harness.service.commit({ preparation });

    expect(Result.isSuccess(committed)).toBe(true);
    expect(harness.policyBindingResolver.calls).toBe(1);
    expect(harness.planRepository.saved).toEqual([preparation.prepared.plan]);
    expect(harness.planRepository.saved[0]?.approvalPlanChecksum).toBe(
      preparation.prepared.plan.approvalPlanChecksum,
    );
    expect(harness.workflowStarter.plans).toHaveLength(1);
    expect(harness.executor.calls).toHaveLength(0);
  });

  it("no-approval preparationはcommit後に既存executor pathで実行される", async () => {
    const harness = createHarness({ approvalRequired: false });
    const preparation = await prepared(harness);

    const committed = await harness.service.commit({ preparation });

    expect(Result.isSuccess(committed) && committed.value).toMatchObject({
      type: "accepted",
      view: { status: "executed" },
    });
    expect(harness.executor.calls).toHaveLength(1);
    expect(harness.authorizer.calls).toBe(2);
  });

  it("authorization denyのpreparationはcommitでdenial auditだけを残す", async () => {
    const harness = createHarness({ allowed: false, approvalRequired: true });
    const preparation = await prepared(harness);
    expect(preparation.type).toBe("authorization_denied");
    expect(harness.eventRepository.records).toHaveLength(0);

    const committed = await harness.service.commit({ preparation });

    expect(Result.isSuccess(committed) && committed.value.type).toBe("authorization_denied");
    expect(harness.eventRepository.records.map((record) => record.event.type)).toEqual([
      "action.authorization_denied",
    ]);
    expect(harness.planRepository.saved).toHaveLength(0);
    expect(harness.workflowStarter.plans).toHaveLength(0);
  });

  it("改変されたprepared planはcommitできない", async () => {
    const harness = createHarness({ approvalRequired: true });
    const preparation = await prepared(harness);
    assert(preparation.type === "prepared");

    const tampered = structuredClone(preparation);
    tampered.prepared.plan = { ...tampered.prepared.plan, flow: { type: "none" } };
    tampered.prepared.approvalRequired = false;
    const committed = await harness.service.commit({ preparation: tampered });

    expect(Result.isFailure(committed) && committed.error.code).toBe(
      "prepared_action_request_invalid",
    );
    expect(harness.planRepository.saved).toHaveLength(0);
    expect(harness.workflowStarter.plans).toHaveLength(0);
  });

  it("保存済みPlanはresume指定時だけ同じpreparationのcommitを再開できる", async () => {
    const harness = createHarness({ approvalRequired: true });
    const preparation = await prepared(harness);
    harness.planRepository.saveResult = "existing";

    const strict = await harness.service.commit({ preparation });
    expect(Result.isFailure(strict) && strict.error.code).toBe("action_request_already_exists");
    expect(harness.workflowStarter.plans).toHaveLength(0);

    const resumed = await harness.service.commit({ preparation, resume: true });
    expect(Result.isSuccess(resumed) && resumed.value).toMatchObject({
      type: "accepted",
      view: { status: "pending_approval" },
    });
    expect(harness.workflowStarter.plans).toHaveLength(1);
  });
});
