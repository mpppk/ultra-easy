import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  createPublicApplicationApprovalPolicyApi,
  type ActionWorkflowStarter,
} from "@app/approval-application";
import {
  APPLICATION_APPROVAL_POLICY_EXECUTOR_KEY,
  ApplicationApprovalPolicyExecutor,
  actionEventRecord,
  actionExecutionOutcomeEvents,
  brandLiteral,
  executeAuthorizedAction,
  parseBrand,
  reauthorizeActionForExecution,
  type ActionAuthorizer,
  type ActionRequest,
  type ActionRequestId,
  type JsonObject,
  type PrincipalRef,
} from "@app/approval-core";
import { D1ApplicationApprovalPolicyRepository, D1PublicApiRepository } from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import { createWorkflowPlatform } from "@app/workflow-platform";

import { StagingSchemaResolver } from "../staging-schema-resolver.ts";
import { APPLICATION_CATALOGS } from "./knowledge.ts";
import { catalogApprovalSchemes } from "./manifest.ts";
import { catalogActionExecutors } from "./runtime.ts";

const ORG = brandLiteral("OrganizationId", "organization:staging");
const OWNER = { type: "user" as const, id: brandLiteral("UserId", "user:owner") };
const EDITOR: PrincipalRef = { type: "user", id: brandLiteral("UserId", "user:editor") };
const NOW = "2026-09-30T00:00:00.000Z";

class AllowAuthorizer implements ActionAuthorizer {
  async check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: "minimize_latency" | "higher_consistency";
  }) {
    return Result.succeed({
      type: "allow" as const,
      evidence: {
        evaluatedAt: input.evaluatedAt,
        consistency: input.consistency,
        provider: "test",
      },
    });
  }
}

/** Knowledge `/mcp`の代役。publishは常に成功する。 */
const knowledge = {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { id: string };
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { resultType: "complete", content: [], structuredContent: { ok: true } },
    });
  },
};

function harness() {
  const db = migratedSqliteD1();
  const authorizer = new AllowAuthorizer();
  const started: ActionRequestId[] = [];
  const workflowStarter: ActionWorkflowStarter = {
    start: async (input) => {
      started.push(input.plan.actionRequestId);
      return Result.succeed({
        workflowInstanceId: `approval:${String(input.plan.actionRequestId)}`,
      });
    },
  };
  const policies = new D1ApplicationApprovalPolicyRepository(db);
  const platform = createWorkflowPlatform({
    db,
    organizationId: ORG,
    clock: { now: () => NOW },
    authorizer,
    primitiveExecutors: {
      ...catalogActionExecutors({
        DB: db,
        KNOWLEDGE: knowledge,
        KNOWLEDGE_MCP_TOKEN: "token",
      } as unknown as Parameters<typeof catalogActionExecutors>[0]),
      [String(APPLICATION_APPROVAL_POLICY_EXECUTOR_KEY)]: new ApplicationApprovalPolicyExecutor({
        schemes: catalogApprovalSchemes(APPLICATION_CATALOGS),
        repository: policies,
      }),
    },
    workflowStarter,
    schemaResolver: new StagingSchemaResolver(),
    pollIntervalSeconds: 5,
  });

  async function submit(
    actionType: string,
    spaceId: string,
    input: JsonObject,
    actor: PrincipalRef = OWNER,
  ) {
    const type = parseBrand("ActionType", actionType);
    const resourceType = parseBrand("ResourceType", "knowledge_space");
    const resourceId = parseBrand("ResourceId", spaceId);
    assert(
      Result.isSuccess(type) && Result.isSuccess(resourceType) && Result.isSuccess(resourceId),
    );
    const submitted = await platform.service.submit({
      action: {
        type: type.value,
        resource: { type: resourceType.value, id: resourceId.value },
        input,
      },
      trustedContext: {
        actor,
        authority: { principal: actor },
        origin: { type: "api" },
        organization: { id: ORG, settings: {} },
        now: NOW,
      },
    });
    assert(Result.isSuccess(submitted), Result.isFailure(submitted) ? submitted.error.message : "");
    assert(submitted.value.type === "accepted");
    return submitted.value;
  }

  const propose = (spaceId: string, baseVersion: number, rules: JsonObject[]) =>
    submit("application.approval_policy.update", spaceId, {
      baseVersion,
      policy: { rules },
    });

  const publishConfidential = (spaceId: string, actor: PrincipalRef = EDITOR) =>
    submit(
      "knowledge.revision.publish",
      spaceId,
      {
        publicationSnapshotId: "snap-1",
        visibility: "space",
        sensitivity: "confidential",
        pageOwnerId: OWNER.id,
      },
      actor,
    );

  async function plan(actionRequestId: ActionRequestId) {
    const loaded = await platform.repositories.plans.load({ organizationId: ORG, actionRequestId });
    assert(loaded.type === "found");
    return loaded.plan;
  }

  async function status(actionRequestId: ActionRequestId) {
    const loaded = await platform.statuses.status({ organizationId: ORG, actionRequestId });
    assert(Result.isSuccess(loaded));
    return loaded.value?.status ?? null;
  }

  /** 承認済みとして、Durable Approval Workflowと同じ再認可 → 実行 → 結果記録を行う。 */
  async function approve(actionRequestId: ActionRequestId) {
    const approved = await plan(actionRequestId);
    await platform.repositories.events.appendMany([
      actionEventRecord({
        organizationId: ORG,
        occurredAt: NOW,
        event: { type: "approval.approved", actionRequestId },
      }),
    ]);
    const reauthorized = await reauthorizeActionForExecution({
      authorizer,
      request: {
        actor: approved.evaluationSnapshot.actor,
        authority: approved.evaluationSnapshot.authority,
        origin: approved.evaluationSnapshot.origin,
        action: {
          type: approved.action.type,
          resource: approved.action.resource,
          input: approved.action.input,
        },
      },
      evaluatedAt: NOW,
    });
    assert(Result.isSuccess(reauthorized) && reauthorized.value.type !== "authorization_revoked");
    const executed = await executeAuthorizedAction({
      executor: platform.registry,
      organizationId: ORG,
      actionRequestId,
      actionFingerprint: approved.actionFingerprint,
      action: approved.action,
      authorizationEvidence: reauthorized.value.authorizationEvidence,
      actor: approved.evaluationSnapshot.actor,
    });
    if (Result.isFailure(executed)) {
      await platform.repositories.results.save(
        {
          organizationId: ORG,
          actionRequestId,
          status: "execution_failed",
          code: executed.error.code,
          message: executed.error.message,
          completedAt: NOW,
        },
        actionExecutionOutcomeEvents({
          organizationId: ORG,
          actionRequestId,
          status: "execution_failed",
          completedAt: NOW,
          code: executed.error.code,
          message: executed.error.message,
        }),
      );
      return executed.error.code;
    }
    assert(executed.value.type === "executed");
    await platform.repositories.results.save(
      {
        organizationId: ORG,
        actionRequestId,
        status: "executed",
        guaranteeLevel: executed.value.guaranteeLevel,
        idempotencyKey: executed.value.idempotencyKey,
        result: executed.value.result,
        completedAt: NOW,
      },
      actionExecutionOutcomeEvents({
        organizationId: ORG,
        actionRequestId,
        status: "executed",
        completedAt: NOW,
        authorizationEvidence: executed.value.authorizationEvidence,
        idempotencyKey: executed.value.idempotencyKey,
      }),
    );
    return "executed";
  }

  const readApi = createPublicApplicationApprovalPolicyApi({
    schemes: catalogApprovalSchemes(APPLICATION_CATALOGS),
    repository: policies,
    actionRequests: new D1PublicApiRepository(db),
    identityProvider: {
      authenticate: async () => Result.succeed(OWNER as PrincipalRef),
    },
    accessChecker: { canView: async () => Result.succeed(true) },
  });
  async function view(spaceId: string) {
    const response = await readApi.fetch(
      new Request(
        `https://api.example/v1/organizations/${encodeURIComponent(String(ORG))}/application-policies/knowledge_space/${spaceId}`,
      ),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      version: number;
      policy: { rules: { key: string }[] };
      pendingChange: { actionRequestId: string; policy: { rules: unknown[] } } | null;
    };
  }

  return {
    platform,
    submit,
    propose,
    publishConfidential,
    plan,
    status,
    approve,
    view,
    policies,
    started,
  };
}

describe("Governed application approval policy (#199)", () => {
  it("applies the bootstrapped default rules until a space has its own", async () => {
    const h = harness();
    const publish = await h.publishConfidential("spc-1");
    expect(publish.view.status).toBe("pending_approval");
    const initial = await h.view("spc-1");
    expect(initial.version).toBe(0);
    expect(initial.policy.rules.map((rule) => rule.key)).toEqual([
      "publish_confidential",
      "publish_organization",
      "archive",
    ]);
    expect(initial.pendingChange).toBeNull();
  });

  it("never changes a space's rules without meta-approval, even for a sole owner", async () => {
    const h = harness();
    const proposal = await h.propose("spc-1", 0, []);
    expect(proposal.view.status).toBe("pending_approval");
    expect((await h.plan(proposal.actionRequestId)).flow.type).not.toBe("none");
    // Not applied: the default confidential rule still requires an approval.
    expect((await h.publishConfidential("spc-1")).view.status).toBe("pending_approval");
    const pending = await h.view("spc-1");
    expect(pending.version).toBe(0);
    expect(pending.pendingChange).toMatchObject({
      actionRequestId: String(proposal.actionRequestId),
      policy: { rules: [] },
    });
    const current = await h.policies.current({
      organizationId: ORG,
      application: "knowledge",
      scopeType: "knowledge_space",
      scopeId: "spc-1",
    });
    expect(current).toEqual(Result.succeed(null));
  });

  it("applies approved rules to new ActionRequests only, and to that space only", async () => {
    const h = harness();
    const before = await h.publishConfidential("spc-1");
    const planBefore = await h.plan(before.actionRequestId);
    const proposal = await h.propose("spc-1", 0, []);
    expect(await h.approve(proposal.actionRequestId)).toBe("executed");

    const after = await h.view("spc-1");
    expect(after).toMatchObject({ version: 1, policy: { rules: [] }, pendingChange: null });

    // New requests in spc-1 follow the new (empty) rules and execute without approval.
    const next = await h.publishConfidential("spc-1");
    expect(next.view.status).toBe("executed");
    // The request made before the change keeps its materialized plan.
    expect(await h.status(before.actionRequestId)).toBe("pending_approval");
    const planAfter = await h.plan(before.actionRequestId);
    expect(String(planAfter.approvalPlanChecksum)).toBe(String(planBefore.approvalPlanChecksum));
    expect(planAfter.flow).toEqual(planBefore.flow);
    // Other spaces keep the default rules.
    expect((await h.publishConfidential("spc-2")).view.status).toBe("pending_approval");
  });

  it("routes a customized rule to the page owner and rejects a stale proposal", async () => {
    const h = harness();
    const first = await h.propose("spc-1", 0, [
      {
        key: "publish_confidential",
        actionType: "knowledge.revision.publish",
        when: { field: "sensitivity", equals: "confidential" },
        approvers: "page_owner",
      },
    ]);
    const stale = await h.propose("spc-1", 0, []);
    expect(await h.approve(first.actionRequestId)).toBe("executed");
    expect(await h.approve(stale.actionRequestId)).toBe("application_policy_conflict");
    expect((await h.view("spc-1")).version).toBe(1);

    const publish = await h.publishConfidential("spc-1");
    expect(publish.view.status).toBe("pending_approval");
    expect((await h.plan(publish.actionRequestId)).flow).toMatchObject({
      type: "approval",
      target: { type: "user", userId: OWNER.id },
    });
  });

  it("rejects a proposal outside the application's vocabulary before any approval", async () => {
    const h = harness();
    const submitted = await h.platform.service.submit({
      action: {
        type: brandLiteral("ActionType", "application.approval_policy.update"),
        resource: {
          type: brandLiteral("ResourceType", "knowledge_space"),
          id: brandLiteral("ResourceId", "spc-1"),
        },
        input: {
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
        },
      },
      trustedContext: {
        actor: OWNER,
        authority: { principal: OWNER },
        origin: { type: "api" },
        organization: { id: ORG, settings: {} },
        now: NOW,
      },
    });
    expect(Result.isFailure(submitted) || submitted.value.type !== "accepted").toBe(true);
    expect(h.started).toEqual([]);
  });
});
