import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  ActionRequestApplicationService,
  ActionRequestDependencyError,
  type ActionWorkflowStarter,
  type TrustedActionRequestContext,
  type VersionedPolicyBindingResolver,
} from "@app/approval-application";
import {
  GOVERNANCE_ACTION_DEFINITIONS,
  GOVERNANCE_ACTION_TYPES,
  GovernanceActionExecutor,
  WorkflowCancellationError,
  always,
  approve,
  cancelApprovalRuntimeState,
  definePolicy,
  executeActionRequest,
  literal,
  none,
  rule,
  user,
} from "@app/approval-core";
import type {
  Action,
  ActionAuthorizer,
  ActionDefinition,
  ActionExecutionRequest,
  ActionRequest,
  ActionRequestId,
  ApprovalPlanChecksum,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalRuntimeState,
  ApprovalTaskId,
  ApproverCandidateList,
  ApproverResolver,
  ApproverResolverProviderError,
  AuthorizationConsistency,
  GovernancePersistence,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  ResourceId,
  ResourceType,
  UserId,
  VersionedApprovalPolicyBinding,
  WorkflowCancellationControl,
} from "@app/approval-core";
import { InMemoryApprovalRuntime } from "@app/approval-runtime-memory";

function branded<T extends string>(value: string): T {
  return value as T;
}

const org = branded<OrganizationId>("org:m7-governance");
const alice = branded<UserId>("user:alice");
const bob = branded<UserId>("user:bob");
const now = "2026-09-20T10:15:00.000Z";
const targetActionRequestId = branded<ActionRequestId>("action:pending-target");

const schema = {
  "~standard": {
    version: 1,
    vendor: "m7-governance",
    validate(value: unknown) {
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "input must be an object" }] };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

function context(): TrustedActionRequestContext {
  return {
    actor: { type: "user", id: alice },
    authority: { principal: { type: "user", id: alice } },
    origin: { type: "api" },
    organization: { id: org },
    now,
  };
}

function governanceAction(
  type: Action["type"],
  input: Record<string, unknown>,
  resourceId = "governance:root",
): Action {
  return {
    type,
    resource: {
      type: branded<ResourceType>("governance"),
      id: branded<ResourceId>(resourceId),
    },
    input,
  };
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

class MutableAuthorizer implements ActionAuthorizer {
  allowed = true;

  check(input: Parameters<ActionAuthorizer["check"]>[0]) {
    return Promise.resolve(
      Result.succeed(
        this.allowed
          ? {
              type: "allow" as const,
              evidence: {
                evaluatedAt: input.evaluatedAt,
                consistency: input.consistency,
                provider: "m7-governance-test",
              },
            }
          : {
              type: "deny" as const,
              code: "governance_forbidden",
              reason: "governance authority required",
            },
      ),
    );
  }
}

class Resolver implements ApproverResolver {
  list(input: {
    target: Parameters<ApproverResolver["list"]>[0]["target"];
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
    return Promise.resolve(
      Result.succeed({
        userIds: input.target.type === "user" ? [input.target.userId] : [bob],
        complete: true,
      }),
    );
  }

  async check(
    input: Parameters<ApproverResolver["check"]>[0],
  ): Result.ResultAsync<boolean, ApproverResolverProviderError> {
    const listed = await this.list(input);
    return Result.isFailure(listed)
      ? listed
      : Result.succeed(listed.value.userIds.some((id) => String(id) === String(input.userId)));
  }
}

class Plans implements MaterializedPlanRepository {
  values = new Map<string, MaterializedApprovalPlan>();

  save(plan: MaterializedApprovalPlan) {
    this.values.set(String(plan.actionRequestId), plan);
    return Promise.resolve({ type: "created" as const });
  }

  load(input: Parameters<MaterializedPlanRepository["load"]>[0]) {
    const plan = this.values.get(String(input.actionRequestId));
    return Promise.resolve(plan ? ({ type: "found", plan } as const) : ({ type: "not_found" } as const));
  }
}

class MetaPolicyResolver implements VersionedPolicyBindingResolver {
  resolve(
    input: Parameters<VersionedPolicyBindingResolver["resolve"]>[0],
  ): Result.ResultAsync<readonly VersionedApprovalPolicyBinding[], ActionRequestDependencyError> {
    if (String(input.context.action.type) !== String(GOVERNANCE_ACTION_TYPES.approvalPolicyPublish)) {
      return Promise.resolve(Result.succeed([]));
    }

    const policyKey = branded<ApprovalPolicyKey>("policy:governance-publish");
    const source: VersionedApprovalPolicyBinding = {
      binding: {
        id: branded<ApprovalPolicyBindingId>("binding:governance-publish"),
        organizationId: org,
        policyKey,
        selector: { actionTypes: [GOVERNANCE_ACTION_TYPES.approvalPolicyPublish] },
        enabled: true,
      },
      policyVersion: 1,
      policy: definePolicy({
        key: String(policyKey),
        name: "governance publish approval",
        rules: [
          rule("default", {
            when: always(),
            flow: approve({ key: "governance-admin", approver: user(literal(String(bob))) }),
          }),
        ],
      }),
    };
    return Promise.resolve(Result.succeed([source]));
  }
}

class Persistence implements GovernancePersistence {
  policies: Array<Parameters<GovernancePersistence["publishApprovalPolicy"]>[0]> = [];
  forceCancels: Array<Parameters<GovernancePersistence["recordForceCancel"]>[0]> = [];

  publishActionDefinition() {
    return Promise.resolve(Result.succeed(undefined));
  }

  publishApprovalPolicy(input: Parameters<GovernancePersistence["publishApprovalPolicy"]>[0]) {
    this.policies.push(input);
    return Promise.resolve(Result.succeed(undefined));
  }

  updateApprovalPolicyBinding() {
    return Promise.resolve(Result.succeed(undefined));
  }

  recordForceCancel(input: Parameters<GovernancePersistence["recordForceCancel"]>[0]) {
    this.forceCancels.push(input);
    return Promise.resolve(Result.succeed(undefined));
  }
}

class Cancellation implements WorkflowCancellationControl {
  state: ApprovalRuntimeState = {
    schemaVersion: 1,
    actionRequestId: targetActionRequestId,
    approvalPlanChecksum: branded<ApprovalPlanChecksum>("checksum:target"),
    interpreterSemanticsVersion: 1,
    status: "pending",
    startedAt: now,
    tasks: [],
    processedDecisionKeys: [],
  };

  cancel(input: Parameters<WorkflowCancellationControl["cancel"]>[0]) {
    if (String(input.actionRequestId) !== String(this.state.actionRequestId)) {
      return Promise.resolve(
        Result.fail(new WorkflowCancellationError("target_not_found", false, "target not found")),
      );
    }
    const transition = cancelApprovalRuntimeState(this.state, input.cancelledAt);
    if (!transition.cancelled) {
      return Promise.resolve(
        Result.fail(new WorkflowCancellationError("target_not_pending", false, "target not pending")),
      );
    }
    this.state = transition.state;
    return Promise.resolve(Result.succeed({ duplicate: transition.duplicate }));
  }
}

function createHarness() {
  const authorizer = new MutableAuthorizer();
  const plans = new Plans();
  const runtime = new InMemoryApprovalRuntime(new Resolver());
  const persistence = new Persistence();
  const cancellation = new Cancellation();
  const executor = new GovernanceActionExecutor(persistence, cancellation);
  let sequence = 0;

  const workflowStarter: ActionWorkflowStarter = {
    async start(input) {
      const started = await runtime.start({ plan: input.plan, startedAt: input.startedAt });
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
    },
  };

  const definitions = new Map(
    GOVERNANCE_ACTION_DEFINITIONS.map((definition) => [String(definition.actionType), definition]),
  );

  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: {
      resolve(actionType) {
        const definition = definitions.get(String(actionType));
        if (!definition) throw new Error("definition not found");
        return definition;
      },
    },
    schemaResolver: { resolve: () => schema },
    policyBindingResolver: new MetaPolicyResolver(),
    authorizer,
    executor,
    planRepository: plans,
    workflowStarter,
    idGenerator: {
      next: () => branded<ActionRequestId>(`action:governance-${++sequence}`),
    },
  });

  return { authorizer, plans, runtime, persistence, cancellation, executor, service };
}

describe("M7 governance acceptance", () => {
  it("AC-M7-002: approval_policy.publishは通常ActionRequestでapprove後にpublishされる", async () => {
    const h = createHarness();
    const policy = definePolicy({
      key: "policy:ticket-change",
      name: "ticket change",
      rules: [rule("default", { when: always(), flow: none() })],
    });

    const submitted = await h.service.submit({
      action: governanceAction(GOVERNANCE_ACTION_TYPES.approvalPolicyPublish, {
        version: 1,
        policy,
      }),
      trustedContext: context(),
    });
    assert(Result.isSuccess(submitted));
    assert(submitted.value.type === "accepted");
    expect(submitted.value.view.status).toBe("pending_approval");
    expect(h.persistence.policies).toHaveLength(0);

    const state = await h.runtime.load(submitted.value.actionRequestId);
    assert(Result.isSuccess(state));
    assert(state.value);
    const task = state.value.tasks[0];
    assert(task);

    const decision = await h.runtime.decide({
      actionRequestId: submitted.value.actionRequestId,
      event: {
        idempotencyKey: "approve-governance-policy",
        taskId: task.id as ApprovalTaskId,
        userId: bob,
        decision: "approve",
        decidedAt: now,
      },
    });
    assert(Result.isSuccess(decision));
    expect(decision.value.state.status).toBe("approved");

    const plan = h.plans.values.get(String(submitted.value.actionRequestId));
    assert(plan);
    const executed = await executeActionRequest({
      authorizer: h.authorizer,
      executor: h.executor,
      organizationId: plan.organizationId,
      actionRequestId: plan.actionRequestId,
      request: requestFromPlan(plan),
      actionFingerprint: plan.actionFingerprint,
      action: plan.action,
      evaluatedAt: now,
    });
    assert(Result.isSuccess(executed));
    expect(executed.value.type).toBe("executed");
    expect(h.persistence.policies).toHaveLength(1);
    expect(h.persistence.policies[0]?.actor).toEqual({ type: "user", id: alice });
  });

  it("AC-M7-002: unauthorized publishはapproval/executionへ進まない", async () => {
    const h = createHarness();
    h.authorizer.allowed = false;
    const submitted = await h.service.submit({
      action: governanceAction(GOVERNANCE_ACTION_TYPES.approvalPolicyPublish, {
        version: 1,
        policy: definePolicy({
          key: "policy:denied",
          name: "denied",
          rules: [rule("default", { when: always(), flow: none() })],
        }),
      }),
      trustedContext: context(),
    });
    assert(Result.isSuccess(submitted));
    expect(submitted.value.type).toBe("authorization_denied");
    expect(h.persistence.policies).toHaveLength(0);
  });

  it("AC-M7-003: admin.force_cancelは理由・actor・post reviewをauditしreplay-safe", async () => {
    const h = createHarness();
    const action = governanceAction(
      GOVERNANCE_ACTION_TYPES.adminForceCancel,
      { targetActionRequestId: String(targetActionRequestId), reason: "incident containment" },
      String(targetActionRequestId),
    );

    const first = await h.service.submit({ action, trustedContext: context() });
    assert(Result.isSuccess(first));
    assert(first.value.type === "accepted");
    expect(first.value.view.status).toBe("executed");
    expect(h.cancellation.state.status).toBe("cancelled");
    expect(h.persistence.forceCancels[0]).toMatchObject({
      targetActionRequestId,
      actor: { type: "user", id: alice },
      reason: "incident containment",
      postReviewRequired: true,
    });

    const replay = await h.executor.execute({
      organizationId: org,
      actionRequestId: first.value.actionRequestId,
      actionFingerprint: first.value.plan.actionFingerprint,
      idempotencyKey: "force-cancel-replay",
      action: first.value.plan.action,
      authorizationEvidence: {
        evaluatedAt: now,
        consistency: "fully_consistent",
      },
      actor: { type: "user", id: alice },
    } satisfies ActionExecutionRequest);
    assert(Result.isSuccess(replay));
    expect(replay.value.output).toMatchObject({ duplicate: true, postReviewRequired: true });
  });

  it("AC-M7-003: force cancel reasonは必須でforce approve actionは存在しない", async () => {
    const h = createHarness();
    const invalid = await h.service.submit({
      action: governanceAction(GOVERNANCE_ACTION_TYPES.adminForceCancel, {
        targetActionRequestId: String(targetActionRequestId),
        reason: "   ",
      }),
      trustedContext: context(),
    });
    assert(Result.isFailure(invalid));
    expect(invalid.error.code).toBe("execution_failed");
    expect(GOVERNANCE_ACTION_DEFINITIONS.some((item: ActionDefinition) => String(item.actionType) === "admin.force_approve")).toBe(false);
    expect(h.cancellation.state.status).toBe("pending");
    expect(h.persistence.forceCancels).toHaveLength(0);
  });
});
