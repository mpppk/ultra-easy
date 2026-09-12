import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  NoApproverCandidatesError,
  IncompleteApproverCandidatesError,
  approve,
  authorizeActionRequest,
  caller,
  checkApprovalDecisionCandidate,
  definePolicy,
  managerOf,
  materializeApprovalPlan,
  reauthorizeActionRequest,
  refreshApproverCandidateProjection,
  resolveApproverCandidates,
  rule,
  always,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalTaskCandidateProjection,
  ApprovalTaskId,
  ApproverCandidateList,
  ApproverCandidateProjectionRepository,
  ApproverResolver,
  ApproverResolverProviderError,
  AuthorizationConsistency,
  AuthorizationDecision,
  AuthorizationObjectRef,
  ExecutorKey,
  MaterializedApprovalStep,
  MaterializedStepId,
  OrganizationId,
  PolicyEvaluationContext,
  RelationName,
  ResolvedApproverTarget,
  SchemaKey,
  UserId,
} from "@app/approval-core";
import {
  createAgentActionRequest,
  createDelegatedAgentActionRequest,
  createHumanActionRequest,
  fixtureIds,
} from "@app/approval-core/testing";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:m3");
const bob = branded<UserId>("user:bob");

class FakeAuthorizer implements ActionAuthorizer {
  readonly calls: AuthorizationConsistency[] = [];

  constructor(private readonly allowed: boolean) {}

  async check(input: {
    request: ReturnType<typeof createHumanActionRequest>;
    evaluatedAt: string;
    consistency: AuthorizationConsistency;
  }) {
    this.calls.push(input.consistency);
    const decision: AuthorizationDecision = this.allowed
      ? {
          type: "allow",
          evidence: {
            evaluatedAt: input.evaluatedAt,
            provider: "fake",
            consistency: input.consistency,
          },
        }
      : { type: "deny", code: "not_allowed", reason: "fake deny" };
    return Result.succeed(decision);
  }
}

class MutableApproverResolver implements ApproverResolver {
  userIds: UserId[];
  complete: boolean;
  readonly listConsistencies: AuthorizationConsistency[] = [];
  readonly checkConsistencies: AuthorizationConsistency[] = [];

  constructor(userIds: UserId[], complete = true) {
    this.userIds = userIds;
    this.complete = complete;
  }

  async check(input: {
    target: ResolvedApproverTarget;
    userId: UserId;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, ApproverResolverProviderError> {
    this.checkConsistencies.push(input.consistency);
    return Result.succeed(this.userIds.some((userId) => String(userId) === String(input.userId)));
  }

  async list(input: {
    target: ResolvedApproverTarget;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
    this.listConsistencies.push(input.consistency);
    return Result.succeed({ userIds: [...this.userIds], complete: this.complete });
  }
}

class InMemoryProjectionRepository implements ApproverCandidateProjectionRepository {
  projection: ApprovalTaskCandidateProjection | null = null;

  async replace(projection: ApprovalTaskCandidateProjection) {
    this.projection = structuredClone(projection);
    return Result.succeed(undefined);
  }

  async load() {
    return Result.succeed(this.projection ? structuredClone(this.projection) : null);
  }
}

function relationTarget(object = "user:alice", relation = "manager"): ResolvedApproverTarget {
  return {
    type: "relation",
    object: branded<AuthorizationObjectRef>(object),
    relation: branded<RelationName>(relation),
    sourceKind: "principal_relation",
  };
}

function materializedStep(input: Partial<MaterializedApprovalStep> = {}): MaterializedApprovalStep {
  return {
    type: "approval",
    materializedStepId: branded<MaterializedStepId>("mstep:m3-manager"),
    stepKey: branded("manager"),
    source: {
      policyBindingId: branded<ApprovalPolicyBindingId>("binding:m3"),
      policyKey: branded<ApprovalPolicyKey>("policy:m3"),
      policyVersion: 1,
      flowPath: "root",
    },
    target: relationTarget(),
    resolution: "dynamic",
    candidateCompletion: "any",
    ...input,
  };
}

async function callerManagerStep(): Promise<MaterializedApprovalStep> {
  const request = createAgentActionRequest();
  const context: PolicyEvaluationContext = {
    ...request,
    organization: { id: organizationId },
    now: "2026-09-12T12:00:00.000Z",
  };
  const policyKey = branded<ApprovalPolicyKey>("policy:caller-manager");
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>("binding:caller-manager"),
    organizationId,
    policyKey,
    selector: { actionTypes: [request.action.type] },
    enabled: true,
  };
  const actionDefinition: ActionDefinition = {
    key: branded<ActionDefinitionKey>("ticket-priority-change"),
    version: 1,
    actionType: request.action.type,
    inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
    executorKey: branded<ExecutorKey>("ticket-executor"),
  };
  const plan = await materializeApprovalPlan({
    actionRequestId: branded<ActionRequestId>("action-request:m3-caller-manager"),
    context,
    actionDefinition,
    policyBindings: [
      {
        binding,
        policyVersion: 1,
        policy: definePolicy({
          key: String(policyKey),
          name: "Caller Manager",
          rules: [
            rule("default", {
              when: always(),
              flow: approve({ key: "manager", approver: managerOf(caller()) }),
            }),
          ],
        }),
      },
    ],
  });
  assert(plan.type === "materialized", plan.type === "error" ? plan.message : undefined);
  assert(plan.plan.flow.type === "approval");
  return plan.plan.flow;
}

describe("M3 Authorization / Approver Resolution", () => {
  it("AC-M3-001: Authorization denyはApprovalへ進めない", async () => {
    const authorizer = new FakeAuthorizer(false);
    const result = await authorizeActionRequest({
      authorizer,
      request: createHumanActionRequest(),
      evaluatedAt: "2026-09-12T12:00:00.000Z",
    });

    assert(Result.isSuccess(result));
    expect(result.value).toEqual({ type: "deny", code: "not_allowed", reason: "fake deny" });
  });

  it("AC-M3-002: callerが承認可能でもauthority denyを覆せない", async () => {
    const request = createAgentActionRequest();
    const resolver = new MutableApproverResolver([fixtureIds.alice]);
    const callerApproval = await checkApprovalDecisionCandidate({
      resolver,
      target: { type: "user", userId: fixtureIds.alice, sourceKind: "principal" },
      userId: fixtureIds.alice,
    });
    assert(Result.isSuccess(callerApproval));
    expect(callerApproval.value).toBe(true);

    const authorizer = new FakeAuthorizer(false);
    const reauthorization = await reauthorizeActionRequest({
      authorizer,
      request,
      evaluatedAt: "2026-09-12T12:01:00.000Z",
    });
    assert(Result.isSuccess(reauthorization));
    expect(reauthorization.value.type).toBe("deny");
  });

  it("AC-M3-003: principal_relation(caller, manager)からcallerのmanagerをresolveする", async () => {
    const step = await callerManagerStep();
    expect(step.target).toEqual(relationTarget("user:alice", "manager"));

    const resolver = new MutableApproverResolver([bob]);
    const candidates = await resolveApproverCandidates({ resolver, step });
    assert(Result.isSuccess(candidates));
    expect(candidates.value.userIds.map(String)).toEqual(["user:bob"]);
  });

  it("AC-M3-004: zero candidateはfail closed", async () => {
    const result = await resolveApproverCandidates({
      resolver: new MutableApproverResolver([]),
      step: materializedStep(),
    });

    assert(Result.isFailure(result));
    expect(result.error).toBeInstanceOf(NoApproverCandidatesError);
  });

  it("AC-M3-005: all/quorumでListUsersがincompleteなら開始しない", async () => {
    const resolver = new MutableApproverResolver([fixtureIds.alice, bob], false);
    const all = await resolveApproverCandidates({
      resolver,
      step: materializedStep({ resolution: "snapshot", candidateCompletion: "all" }),
    });
    const quorum = await resolveApproverCandidates({
      resolver,
      step: materializedStep({
        resolution: "snapshot",
        candidateCompletion: { type: "quorum", count: 2 },
      }),
    });

    assert(Result.isFailure(all));
    assert(Result.isFailure(quorum));
    expect(all.error).toBeInstanceOf(IncompleteApproverCandidatesError);
    expect(quorum.error).toBeInstanceOf(IncompleteApproverCandidatesError);
  });

  it("AC-M3-006: dynamic projectionに残っていてもDecision時にrelationを再Checkする", async () => {
    const resolver = new MutableApproverResolver([fixtureIds.alice]);
    const repository = new InMemoryProjectionRepository();
    const step = materializedStep();
    const projected = await refreshApproverCandidateProjection({
      resolver,
      repository,
      organizationId,
      approvalTaskId: branded<ApprovalTaskId>("task:m3"),
      step,
      resolvedAt: "2026-09-12T12:00:00.000Z",
    });
    assert(Result.isSuccess(projected));
    expect(repository.projection?.candidateUserIds.map(String)).toEqual(["user:alice"]);

    resolver.userIds = [];
    const decision = await checkApprovalDecisionCandidate({
      resolver,
      target: step.target,
      userId: fixtureIds.alice,
    });
    assert(Result.isSuccess(decision));
    expect(decision.value).toBe(false);
  });

  it("AC-M3-007: projectionはminimize latency、Decision/再認可はhigher consistency", async () => {
    const resolver = new MutableApproverResolver([fixtureIds.alice]);
    const repository = new InMemoryProjectionRepository();
    const step = materializedStep();
    await refreshApproverCandidateProjection({
      resolver,
      repository,
      organizationId,
      approvalTaskId: branded<ApprovalTaskId>("task:consistency"),
      step,
      resolvedAt: "2026-09-12T12:00:00.000Z",
    });
    await checkApprovalDecisionCandidate({
      resolver,
      target: step.target,
      userId: fixtureIds.alice,
    });

    const authorizer = new FakeAuthorizer(true);
    await reauthorizeActionRequest({
      authorizer,
      request: createHumanActionRequest(),
      evaluatedAt: "2026-09-12T12:01:00.000Z",
    });

    expect(resolver.listConsistencies).toEqual(["minimize_latency"]);
    expect(resolver.checkConsistencies).toEqual(["higher_consistency"]);
    expect(authorizer.calls).toEqual(["higher_consistency"]);
  });

  it("delegation scopeをchain全体でANDし、scope外Actionはproviderを呼ぶ前にdenyする", async () => {
    const request = createDelegatedAgentActionRequest();
    request.authority.delegation!.chain[0]!.scope = {
      actionTypes: [branded("purchase.request.create")],
    };
    const authorizer = new FakeAuthorizer(true);
    const result = await authorizeActionRequest({
      authorizer,
      request,
      evaluatedAt: "2026-09-12T12:00:00.000Z",
    });

    assert(Result.isSuccess(result));
    expect(result.value).toMatchObject({ type: "deny", code: "delegation_scope_denied" });
    expect(authorizer.calls).toHaveLength(0);
  });
});
