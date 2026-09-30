import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  APPLICATION_APPROVAL_POLICY_ACTION_TYPE,
  ApplicationApprovalPolicyExecutor,
  applicationApprovalPolicyMetaPolicy,
  applicationApprovalPolicyUpdateInputSchema,
  applicationApprovalBindingId,
  applicationApprovalPolicyKey,
  compileApplicationApprovalPolicies,
  validateApplicationApprovalPolicy,
  type ApplicationApprovalPolicy,
  type ApplicationApprovalPolicyRecord,
  type ApplicationApprovalPolicyRepository,
  type ApplicationApprovalScheme,
} from "./application-approval-policy.ts";
import type { ActionExecutionRequest } from "./action-execution.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ActionType,
  ApprovalPolicyBindingId,
  OrganizationId,
  ResourceId,
  ResourceType,
  UserId,
} from "./domain/brand.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import type { ApprovalPolicyBinding, ApprovalPolicyDefinition } from "./domain/policy.ts";
import { evaluateApprovalPlan } from "./policy-evaluator.ts";
import { validateApprovalPolicySemantics } from "./semantic-validator.ts";

const branded = <T extends string>(value: string) => value as T;
const org = branded<OrganizationId>("organization:tenant-a");

const SCHEME: ApplicationApprovalScheme = {
  application: "knowledge",
  scopeResourceType: "knowledge_space",
  policyKey: "app:knowledge:approval",
  bindingId: "binding:app:knowledge:approval",
  metaPolicyKey: "app:knowledge:approval-policy-meta",
  metaBindingId: "binding:app:knowledge:approval-policy-meta",
  actions: [
    {
      actionType: "knowledge.revision.publish",
      conditionFields: ["visibility", "sensitivity"],
      principalFields: ["pageOwnerId"],
    },
    { actionType: "knowledge.page.archive", conditionFields: [], principalFields: ["pageOwnerId"] },
  ],
  approvers: { space_owners: { relation: "owner" }, page_owner: { inputUser: "pageOwnerId" } },
  requesterIsNot: { page_owner: "pageOwnerId" },
  defaultPolicy: {
    rules: [
      {
        key: "publish_confidential",
        actionType: "knowledge.revision.publish",
        when: { field: "sensitivity", equals: "confidential" },
        approvers: "space_owners",
      },
      {
        key: "archive",
        actionType: "knowledge.page.archive",
        when: { requesterIsNot: "page_owner" },
        approvers: "page_owner",
      },
    ],
  },
  metaApprovalRelation: "owner",
};

function context(input: {
  type: string;
  space: string;
  payload: Record<string, string>;
  requester?: string;
}): PolicyEvaluationContext {
  const requester = { type: "user" as const, id: branded<UserId>(input.requester ?? "user:alice") };
  return {
    actor: requester,
    authority: { principal: requester },
    action: {
      type: branded<ActionType>(input.type),
      resource: {
        type: branded<ResourceType>("knowledge_space"),
        id: branded<ResourceId>(input.space),
      },
      input: input.payload,
    },
    origin: { type: "api" },
    organization: { id: org },
    now: "2026-09-30T00:00:00.000Z",
  };
}

function bindings(): ApprovalPolicyBinding[] {
  return SCHEME.actions.map(({ actionType }) => ({
    id: branded<ApprovalPolicyBindingId>(applicationApprovalBindingId(SCHEME, actionType)),
    organizationId: org,
    policyKey: branded(applicationApprovalPolicyKey(SCHEME, actionType)),
    selector: {
      actionTypes: [branded<ActionType>(actionType)],
      resourceTypes: [branded<ResourceType>("knowledge_space")],
    },
    enabled: true,
  }));
}

function flowFor(policies: ApprovalPolicyDefinition[], input: Parameters<typeof context>[0]) {
  const evaluated = evaluateApprovalPlan({
    context: context(input),
    bindings: bindings(),
    policies,
  });
  assert(Result.isSuccess(evaluated), Result.isFailure(evaluated) ? evaluated.error.message : "");
  return evaluated.value.flow;
}

const publishConfidential = {
  type: "knowledge.revision.publish",
  payload: { visibility: "space", sensitivity: "confidential", pageOwnerId: "user:owner" },
};

describe("compileApplicationApprovalPolicy", () => {
  const custom: ApplicationApprovalPolicy = {
    rules: [
      {
        key: "publish_org",
        actionType: "knowledge.revision.publish",
        when: { field: "visibility", equals: "organization" },
        approvers: "page_owner",
      },
    ],
  };
  const policy = compileApplicationApprovalPolicies(SCHEME, [
    { scopeId: "spc-custom", policy: custom },
  ]).map((compiled) => compiled.policy);

  it("produces a semantically valid policy", () => {
    for (const compiled of [...policy, applicationApprovalPolicyMetaPolicy(SCHEME)]) {
      const validation = validateApprovalPolicySemantics(compiled);
      expect(validation.valid ? [] : validation.issues).toEqual([]);
    }
    expect(policy.map((compiled) => String(compiled.key))).toEqual([
      "app:knowledge:approval:knowledge.revision.publish",
      "app:knowledge:approval:knowledge.page.archive",
    ]);
  });

  it("applies the default rules to spaces without their own rules", () => {
    expect(flowFor(policy, { ...publishConfidential, space: "spc-other" })).toMatchObject({
      type: "approval",
      approver: { type: "relation", relation: "owner" },
    });
    expect(
      flowFor(policy, {
        type: "knowledge.revision.publish",
        space: "spc-other",
        payload: { visibility: "space", sensitivity: "internal", pageOwnerId: "user:owner" },
      }),
    ).toEqual({ type: "none" });
  });

  it("replaces the default rules for a space with its own rules (no fall-through)", () => {
    // The default confidential rule no longer applies in the customized space.
    expect(flowFor(policy, { ...publishConfidential, space: "spc-custom" })).toEqual({
      type: "none",
    });
    expect(
      flowFor(policy, {
        type: "knowledge.revision.publish",
        space: "spc-custom",
        payload: { visibility: "organization", sensitivity: "internal", pageOwnerId: "user:owner" },
      }),
    ).toMatchObject({ type: "approval", approver: { type: "user" } });
  });

  it("compares requesterIsNot with the authority principal", () => {
    const archive = (requester: string) =>
      flowFor(policy, {
        type: "knowledge.page.archive",
        space: "spc-other",
        payload: { pageOwnerId: "user:owner" },
        requester,
      });
    expect(archive("user:owner")).toEqual({ type: "none" });
    expect(archive("user:someone")).toMatchObject({ type: "approval" });
  });
});

describe("validateApplicationApprovalPolicy", () => {
  const valid = (policy: unknown) => validateApplicationApprovalPolicy(SCHEME, policy).type;

  it("accepts the scheme's vocabulary", () => {
    expect(valid(SCHEME.defaultPolicy)).toBe("valid");
    expect(valid({ rules: [] })).toBe("valid");
  });

  it.each([
    [
      "an action outside the scheme",
      { key: "x", actionType: "ticket.update", when: { always: true }, approvers: "space_owners" },
    ],
    [
      "an unknown condition field",
      {
        key: "x",
        actionType: "knowledge.revision.publish",
        when: { field: "title", equals: "a" },
        approvers: "space_owners",
      },
    ],
    [
      "an unknown approver",
      {
        key: "x",
        actionType: "knowledge.revision.publish",
        when: { always: true },
        approvers: "anyone",
      },
    ],
    [
      "a field approver the action does not carry",
      {
        key: "x",
        actionType: "knowledge.page.archive",
        when: { always: true },
        approvers: "page_owner",
        extra: 1,
      },
    ],
    [
      "an unknown requesterIsNot",
      {
        key: "x",
        actionType: "knowledge.page.archive",
        when: { requesterIsNot: "admin" },
        approvers: "space_owners",
      },
    ],
    [
      "a raw condition",
      {
        key: "x",
        actionType: "knowledge.page.archive",
        when: { type: "comparison" },
        approvers: "space_owners",
      },
    ],
    [
      "an invalid key",
      {
        key: "X Y",
        actionType: "knowledge.page.archive",
        when: { always: true },
        approvers: "space_owners",
      },
    ],
  ])("rejects %s", (_label, rule) => {
    expect(valid({ rules: [rule] })).toBe("invalid");
  });

  it("validates submitted input before any approval is requested", async () => {
    const schema = applicationApprovalPolicyUpdateInputSchema([SCHEME]);
    const ok = await schema["~standard"].validate({ baseVersion: 0, policy: SCHEME.defaultPolicy });
    expect(ok.issues).toBeUndefined();
    const stale = await schema["~standard"].validate({ baseVersion: -1, policy: { rules: [] } });
    expect(stale.issues?.length).toBeGreaterThan(0);
    const foreign = await schema["~standard"].validate({
      baseVersion: 0,
      policy: {
        rules: [
          {
            key: "x",
            actionType: "ticket.update",
            when: { always: true },
            approvers: "space_owners",
          },
        ],
      },
    });
    expect(foreign.issues?.length).toBeGreaterThan(0);
  });
});

class MemoryRepository implements ApplicationApprovalPolicyRepository {
  records: ApplicationApprovalPolicyRecord[] = [];
  policyVersions = new Map<number, ApprovalPolicyDefinition[]>([
    [1, compileApplicationApprovalPolicies(SCHEME, []).map((compiled) => compiled.policy)],
  ]);
  /** Test hook: another space wins the next N policy versions first. */
  raceNext = 0;

  current(scope: { scopeId: string }) {
    const latest = this.records
      .filter((record) => record.scopeId === scope.scopeId)
      .sort((left, right) => right.version - left.version)[0];
    return Promise.resolve(Result.succeed(latest ?? null));
  }

  listCurrent() {
    const scopes = new Set(this.records.map((record) => record.scopeId));
    return Promise.resolve(
      Result.succeed(
        [...scopes].map(
          (scopeId) =>
            this.records
              .filter((record) => record.scopeId === scopeId)
              .sort(
                (left, right) => right.version - left.version,
              )[0] as ApplicationApprovalPolicyRecord,
        ),
      ),
    );
  }

  latestApprovalPolicyVersion() {
    return Promise.resolve(
      Result.succeed(
        this.policyVersions.size === 0 ? null : Math.max(...this.policyVersions.keys()),
      ),
    );
  }

  apply(input: {
    record: ApplicationApprovalPolicyRecord;
    approvalPolicies: readonly ApprovalPolicyDefinition[];
  }) {
    if (this.raceNext > 0) {
      this.raceNext -= 1;
      this.policyVersions.set(input.record.approvalPolicyVersion, [...input.approvalPolicies]);
      return Promise.resolve(Result.succeed({ type: "conflict" as const }));
    }
    if (
      this.policyVersions.has(input.record.approvalPolicyVersion) ||
      this.records.some(
        (record) =>
          record.scopeId === input.record.scopeId && record.version === input.record.version,
      )
    ) {
      return Promise.resolve(Result.succeed({ type: "conflict" as const }));
    }
    this.records.push(input.record);
    this.policyVersions.set(input.record.approvalPolicyVersion, [...input.approvalPolicies]);
    return Promise.resolve(Result.succeed({ type: "applied" as const }));
  }
}

function executionRequest(input: {
  space?: string;
  baseVersion: number;
  policy?: ApplicationApprovalPolicy;
  id?: string;
}): ActionExecutionRequest {
  return {
    organizationId: org,
    actionRequestId: branded<ActionRequestId>(input.id ?? "ar-1"),
    actionFingerprint: branded<ActionFingerprint>("sha256:fp"),
    idempotencyKey: `key:${input.id ?? "ar-1"}`,
    action: {
      definition: {
        key: branded("application:approval-policy-update"),
        version: 1,
        actionType: APPLICATION_APPROVAL_POLICY_ACTION_TYPE,
        inputSchema: { key: branded("application:approval-policy-update"), version: 1 },
        executorKey: branded("application-policy"),
      },
      type: APPLICATION_APPROVAL_POLICY_ACTION_TYPE,
      resource: {
        type: branded<ResourceType>("knowledge_space"),
        id: branded<ResourceId>(input.space ?? "spc-1"),
      },
      input: { baseVersion: input.baseVersion, policy: input.policy ?? { rules: [] } },
    },
    authorizationEvidence: {
      evaluatedAt: "2026-09-30T00:00:00.000Z",
      consistency: "higher_consistency",
    },
    actor: { type: "user", id: branded<UserId>("user:alice") },
  };
}

describe("ApplicationApprovalPolicyExecutor", () => {
  it("applies an approved rule change as the next scope version and policy version", async () => {
    const repository = new MemoryRepository();
    const executor = new ApplicationApprovalPolicyExecutor({ schemes: [SCHEME], repository });
    const applied = await executor.execute(executionRequest({ baseVersion: 0 }));
    assert(Result.isSuccess(applied));
    expect(applied.value.output).toEqual({
      scopeId: "spc-1",
      version: 1,
      approvalPolicyVersion: 2,
    });
    const policy = repository.policyVersions.get(2);
    assert(policy);
    expect(flowFor(policy, { ...publishConfidential, space: "spc-1" })).toEqual({ type: "none" });

    // Redelivery of the same ActionRequest is idempotent.
    const replay = await executor.execute(executionRequest({ baseVersion: 0 }));
    assert(Result.isSuccess(replay));
    expect(repository.records).toHaveLength(1);
  });

  it("rejects a proposal approved after the rules already changed", async () => {
    const repository = new MemoryRepository();
    const executor = new ApplicationApprovalPolicyExecutor({ schemes: [SCHEME], repository });
    assert(
      Result.isSuccess(await executor.execute(executionRequest({ baseVersion: 0, id: "ar-new" }))),
    );
    const stale = await executor.execute(executionRequest({ baseVersion: 0, id: "ar-old" }));
    assert(Result.isFailure(stale));
    expect(stale.error.code).toBe("application_policy_conflict");
    expect(stale.error.retriable).toBe(false);
    expect(repository.records.map((record) => record.sourceActionRequestId)).toEqual(["ar-new"]);
  });

  it("recompiles when another space took the next policy version", async () => {
    const repository = new MemoryRepository();
    repository.raceNext = 1;
    const executor = new ApplicationApprovalPolicyExecutor({ schemes: [SCHEME], repository });
    const applied = await executor.execute(executionRequest({ baseVersion: 0 }));
    assert(Result.isSuccess(applied));
    expect(applied.value.output).toMatchObject({ approvalPolicyVersion: 3 });
  });

  it("fails closed without the bootstrapped policy or for an unknown scope", async () => {
    const repository = new MemoryRepository();
    repository.policyVersions.clear();
    const executor = new ApplicationApprovalPolicyExecutor({ schemes: [SCHEME], repository });
    const missing = await executor.execute(executionRequest({ baseVersion: 0 }));
    assert(Result.isFailure(missing));
    expect(missing.error.code).toBe("application_policy_not_bootstrapped");

    const request = executionRequest({ baseVersion: 0 });
    const other = await executor.execute({
      ...request,
      action: {
        ...request.action,
        resource: { type: branded<ResourceType>("ticket"), id: branded<ResourceId>("t-1") },
      },
    });
    assert(Result.isFailure(other));
    expect(other.error.code).toBe("application_policy_scope_unknown");
  });
});
