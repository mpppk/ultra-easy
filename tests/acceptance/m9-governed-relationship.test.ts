import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  AUTHORIZATION_ACTION_TYPES,
  AUTHORIZATION_ADMIN_RESOURCE,
  AUTHORIZATION_RELATIONSHIP_UPDATE_DEFINITION,
  AuthorizationProviderError,
  AuthorizationRelationshipCoordinator,
  AuthorizationRelationshipExecutor,
  always,
  approve,
  authorizationAdminActionRelation,
  definePolicy,
  eq,
  executeActionRequest,
  field,
  literal,
  none,
  relationshipTupleKey,
  relationshipUpdateInputSchema,
  rule,
  user,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionRequest,
  ActionRequestId,
  ApprovalPolicyBindingId,
  ApprovalTaskId,
  ApproverResolver,
  AuthorizationDecision,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  RelationshipTuple,
  RelationshipTupleGateway,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";
import {
  ActionRequestApplicationService,
  ActionRequestDependencyError,
  createActionRequestHttpApi,
  type ActionWorkflowStarter,
  type TrustedActionRequestContext,
} from "@app/approval-application";
import { D1AuthorizationRelationshipStore } from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import {
  AUTHORIZATION_MODEL_SOURCE,
  OpenFgaClient,
  OpenFgaRelationshipTupleGateway,
} from "@app/approval-fga";
import { InMemoryApprovalRuntime } from "@app/approval-runtime-memory";

const org = "organization:tenant-a" as OrganizationId;
const otherOrg = "organization:tenant-b" as OrganizationId;
const editor = "user:editor" as UserId;
const outsider = "user:outsider" as UserId;
const approver = "user:security" as UserId;
const now = "2026-09-24T00:00:00.000Z";
const grantExecute: RelationshipTuple = {
  user: "user:alice",
  relation: "can_execute",
  object: "ticket:T-1",
};
const grantApprove: RelationshipTuple = {
  user: "user:alice",
  relation: "can_approve",
  object: "ticket:T-1",
};

/** The staging policy shape: can_approve grants need security approval, others do not. */
function relationshipPolicy(): VersionedApprovalPolicyBinding {
  return {
    binding: {
      id: "binding:authorization-relationship" as ApprovalPolicyBindingId,
      organizationId: org,
      policyKey: "policy:authorization-relationship" as never,
      selector: { actionTypes: [AUTHORIZATION_ACTION_TYPES.relationshipUpdate] },
      enabled: true,
    },
    policyVersion: 1,
    policy: definePolicy({
      key: "policy:authorization-relationship",
      name: "authorization relationship",
      rules: [
        rule("approver-rights", {
          when: eq(field("action.input.tuple.relation"), literal("can_approve")),
          flow: approve({
            key: "security",
            approver: user(literal(String(approver))),
            purpose: "security_approval",
          }),
        }),
        rule("default", { when: always(), flow: none() }),
      ],
    }),
  };
}

/** ActionAuthorizer backed by the provider: editor on authorization_admin:root. */
class ProviderAuthorizer implements ActionAuthorizer {
  constructor(
    private readonly isEditor: (organizationId: OrganizationId, userId: string) => Promise<boolean>,
    private readonly organizationId: OrganizationId,
  ) {}

  async check(input: { request: ActionRequest; evaluatedAt: string }) {
    const relation = authorizationAdminActionRelation({
      actionType: input.request.action.type,
      resource: input.request.action.resource,
    });
    if (!relation) {
      return Result.succeed<AuthorizationDecision>({
        type: "deny",
        code: "action_relation_unmapped",
        reason: "unmapped",
      });
    }
    const allowed = await this.isEditor(
      this.organizationId,
      String(input.request.authority.principal.id),
    ).catch(() => null);
    if (allowed === null) {
      return Result.fail(
        new AuthorizationProviderError({
          provider: "test",
          code: "unavailable",
          retriable: true,
          detail: "down",
        }),
      );
    }
    return Result.succeed<AuthorizationDecision>(
      allowed
        ? {
            type: "allow",
            evidence: { evaluatedAt: input.evaluatedAt, consistency: "higher_consistency" },
          }
        : { type: "deny", code: "fga_check_denied", reason: "not an editor" },
    );
  }
}

class MemoryGateway implements RelationshipTupleGateway {
  readonly authorizationModelId = "model-1";
  readonly tuples = new Set<string>();
  applies = 0;

  private key(organizationId: OrganizationId, tuple: RelationshipTuple) {
    return `${String(organizationId)}|${tuple.user}|${tuple.relation}|${tuple.object}`;
  }

  async read(input: { organizationId: OrganizationId; tuple: RelationshipTuple }) {
    return Result.succeed(this.tuples.has(this.key(input.organizationId, input.tuple)));
  }

  async apply(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
    present: boolean;
  }) {
    this.applies += 1;
    const key = this.key(input.organizationId, input.tuple);
    if (input.present) this.tuples.add(key);
    else this.tuples.delete(key);
    return Result.succeed(undefined);
  }
}

class Plans implements MaterializedPlanRepository {
  readonly plans = new Map<string, MaterializedApprovalPlan>();

  save(plan: MaterializedApprovalPlan) {
    this.plans.set(String(plan.actionRequestId), plan);
    return Promise.resolve({ type: "created" } as const);
  }

  load(input: Parameters<MaterializedPlanRepository["load"]>[0]) {
    const plan = this.plans.get(String(input.actionRequestId));
    return Promise.resolve(
      plan ? ({ type: "found", plan } as const) : ({ type: "not_found" } as const),
    );
  }
}

const directResolver: ApproverResolver = {
  async check(input) {
    return Result.succeed(
      input.target.type === "user" && String(input.target.userId) === String(input.userId),
    );
  },
  async list(input) {
    return Result.succeed(
      input.target.type === "user"
        ? { userIds: [input.target.userId], complete: true }
        : { userIds: [], complete: false },
    );
  },
};

function harness(options: {
  gateway: RelationshipTupleGateway;
  isEditor: (organizationId: OrganizationId, userId: string) => Promise<boolean>;
  organizationId?: OrganizationId;
}) {
  const organizationId = options.organizationId ?? org;
  const db = migratedSqliteD1();
  const store = new D1AuthorizationRelationshipStore(db);
  const coordinator = new AuthorizationRelationshipCoordinator({
    store,
    gateway: options.gateway,
    clock: { now: () => new Date().toISOString() },
  });
  const executor = new AuthorizationRelationshipExecutor(coordinator);
  const authorizer = new ProviderAuthorizer(options.isEditor, organizationId);
  const plans = new Plans();
  const runtime = new InMemoryApprovalRuntime(directResolver);
  let id = 0;
  const workflows: ActionWorkflowStarter = {
    async start(input) {
      const started = await runtime.start({ plan: input.plan, startedAt: input.startedAt });
      return Result.isFailure(started)
        ? Result.fail(new ActionRequestDependencyError("runtime_start_failed", false, "failed"))
        : Result.succeed({ workflowInstanceId: String(input.plan.actionRequestId) });
    },
  };
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: {
      resolve: async () => Result.succeed(AUTHORIZATION_RELATIONSHIP_UPDATE_DEFINITION),
    },
    schemaResolver: { resolve: async () => Result.succeed(relationshipUpdateInputSchema()) },
    policyBindingResolver: { resolve: async () => Result.succeed([relationshipPolicy()]) },
    authorizer,
    executor,
    planRepository: plans,
    resultRepository: new InMemoryActionAuditStore(),
    workflowStarter: workflows,
    idGenerator: { next: () => `action:m9-${++id}` as ActionRequestId },
  });
  let caller: UserId = editor;
  const api = createActionRequestHttpApi({
    service,
    trustedContextProvider: {
      async resolve() {
        const principal = { type: "user" as const, id: caller };
        const context: TrustedActionRequestContext = {
          actor: principal,
          authority: { principal },
          origin: { type: "ui" },
          organization: { id: organizationId },
          now,
        };
        return Result.succeed(context);
      },
    },
  });

  async function submit(input: unknown, as: UserId = editor) {
    caller = as;
    const response = await api.fetch(
      new Request(
        `https://api.example/v1/organizations/${encodeURIComponent(String(organizationId))}/action-requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `k-${id}` },
          body: JSON.stringify({
            action: {
              type: AUTHORIZATION_ACTION_TYPES.relationshipUpdate,
              resource: AUTHORIZATION_ADMIN_RESOURCE,
              input,
            },
          }),
        },
      ),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function approveAndExecute(actionRequestId: string) {
    const state = await runtime.load(actionRequestId as ActionRequestId);
    assert(Result.isSuccess(state) && state.value);
    const task = state.value.tasks[0];
    assert(task);
    const decided = await runtime.decide({
      actionRequestId: actionRequestId as ActionRequestId,
      event: {
        idempotencyKey: `decision-${actionRequestId}`,
        taskId: task.id as ApprovalTaskId,
        userId: approver,
        decision: "approve",
        decidedAt: now,
      },
    });
    assert(Result.isSuccess(decided));
    expect(decided.value.state.status).toBe("approved");
    const plan = plans.plans.get(actionRequestId);
    assert(plan);
    return executeActionRequest({
      authorizer,
      executor,
      organizationId: plan.organizationId,
      actionRequestId: plan.actionRequestId,
      request: {
        actor: plan.evaluationSnapshot.actor,
        authority: plan.evaluationSnapshot.authority,
        origin: plan.evaluationSnapshot.origin,
        action: {
          type: plan.action.type,
          resource: plan.action.resource,
          input: plan.action.input,
        },
      },
      actionFingerprint: plan.actionFingerprint,
      action: plan.action,
      evaluatedAt: now,
    });
  }

  async function relationship(tuple: RelationshipTuple) {
    const key = await relationshipTupleKey({ organizationId, tuple });
    assert(Result.isSuccess(key));
    const loaded = await store.get({ organizationId, tupleKey: key.value });
    assert(Result.isSuccess(loaded));
    return loaded.value;
  }

  function eventCount(): number {
    return (
      db.db.prepare("SELECT COUNT(*) AS count FROM authorization_relationship_events").get() as {
        count: number;
      }
    ).count;
  }

  return { submit, approveAndExecute, relationship, eventCount, plans };
}

describe("M9-2 governed relationship mutation via ActionRequest", () => {
  it("AC-M9-004: editor + no approval → executed with confirmed relationship effect", async () => {
    const gateway = new MemoryGateway();
    const h = harness({ gateway, isEditor: async (_, userId) => userId === String(editor) });
    const submitted = await h.submit({ operation: "write", tuple: grantExecute });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({
      status: "executed",
      approval: { required: false },
      result: {
        status: "executed",
        output: { relationship: { status: "confirmed", effectConfirmed: true, revision: 1 } },
      },
    });
    expect((await h.relationship(grantExecute))?.relationship.syncStatus).toBe("confirmed");
  });

  it("AC-M9-010: non-editor is denied; no desired state, journal or provider change", async () => {
    const gateway = new MemoryGateway();
    const h = harness({ gateway, isEditor: async (_, userId) => userId === String(editor) });
    const denied = await h.submit({ operation: "write", tuple: grantExecute }, outsider);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "fga_check_denied" });
    expect(await h.relationship(grantExecute)).toBeNull();
    expect(h.eventCount()).toBe(0);
    expect(gateway.applies).toBe(0);
  });

  it("AC-M9-005: authorization_admin viewer/editor and non-catalog relations are rejected before an ActionRequest exists", async () => {
    const gateway = new MemoryGateway();
    const h = harness({ gateway, isEditor: async () => true });
    for (const tuple of [
      { user: "user:mallory", relation: "editor", object: "authorization_admin:root" },
      { user: "user:mallory", relation: "viewer", object: "authorization_admin:root" },
      { user: "user:mallory", relation: "owner", object: "ticket:T-1" },
      {
        user: "user:mallory",
        relation: "can_execute",
        object: "ticket:organization%3Atenant-b/T-1",
      },
    ]) {
      const rejected = await h.submit({ operation: "write", tuple });
      expect(rejected.status, JSON.stringify(tuple)).toBe(422);
      expect(rejected.body).toMatchObject({ code: "action_input_validation_failed" });
    }
    expect(h.plans.plans.size).toBe(0);
    expect(h.eventCount()).toBe(0);
    expect(gateway.applies).toBe(0);
  });

  it("editor + approval policy → pending (no change) → approve → re-authorize → confirmed", async () => {
    const gateway = new MemoryGateway();
    const h = harness({ gateway, isEditor: async (_, userId) => userId === String(editor) });
    const submitted = await h.submit({ operation: "write", tuple: grantApprove });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({
      status: "pending_approval",
      approval: { required: true },
    });
    expect(await h.relationship(grantApprove)).toBeNull();
    expect(gateway.applies).toBe(0);

    const executed = await h.approveAndExecute(String(submitted.body.id));
    assert(Result.isSuccess(executed));
    expect(executed.value).toMatchObject({
      type: "executed",
      result: { output: { relationship: { status: "confirmed", effectConfirmed: true } } },
    });
  });

  it("editor revoked while waiting for approval → authorization_revoked, approval cannot override", async () => {
    const gateway = new MemoryGateway();
    let editorActive = true;
    const h = harness({
      gateway,
      isEditor: async (_, userId) => editorActive && userId === String(editor),
    });
    const submitted = await h.submit({ operation: "write", tuple: grantApprove });
    expect(submitted.body.status).toBe("pending_approval");
    editorActive = false;
    const executed = await h.approveAndExecute(String(submitted.body.id));
    assert(Result.isSuccess(executed));
    expect(executed.value.type).toBe("authorization_revoked");
    expect(await h.relationship(grantApprove)).toBeNull();
    expect(gateway.applies).toBe(0);
  });
});

const openFgaApiUrl = process.env.OPENFGA_TEST_URL;
const describeOpenFga = openFgaApiUrl ? describe : describe.skip;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

describeOpenFga("M9-2 against a real OpenFGA store (GitOps model)", () => {
  it("governed write/delete changes Check results; tenant isolation holds; admin tuples stay bootstrap-only", async () => {
    assert(openFgaApiUrl);
    const store = await postJson<{ id: string }>(`${openFgaApiUrl}/stores`, {
      name: `ultra-easy-m9-e2e-${Date.now()}`,
    });
    const model = await postJson<{ authorization_model_id: string }>(
      `${openFgaApiUrl}/stores/${store.id}/authorization-models`,
      AUTHORIZATION_MODEL_SOURCE,
    );
    const clientFor = (organizationId: OrganizationId) =>
      new OpenFgaClient({
        apiUrl: openFgaApiUrl,
        storeId: store.id,
        authorizationModelId: model.authorization_model_id,
        organizationId,
      });
    // bootstrap-only admin membership (IaC path), tenant A only
    const bootstrap = await clientFor(org).writeTuples({
      writes: [{ user: String(editor), relation: "editor", object: "authorization_admin:root" }],
    });
    assert(Result.isSuccess(bootstrap));

    const isEditor = async (organizationId: OrganizationId, userId: string) => {
      const checked = await clientFor(organizationId).check({
        user: userId,
        relation: "editor",
        object: "authorization_admin:root",
        consistency: "higher_consistency",
      });
      return Result.isSuccess(checked) ? checked.value : Promise.reject(checked.error);
    };
    const gateway = new OpenFgaRelationshipTupleGateway({
      authorizationModelId: model.authorization_model_id,
      clientFor,
    });
    const canExecute = async (organizationId: OrganizationId) => {
      const checked = await clientFor(organizationId).check({
        user: grantExecute.user,
        relation: grantExecute.relation,
        object: grantExecute.object,
        consistency: "higher_consistency",
      });
      assert(Result.isSuccess(checked));
      return checked.value;
    };

    const tenantA = harness({ gateway, isEditor });
    const written = await tenantA.submit({ operation: "write", tuple: grantExecute });
    expect(written.body).toMatchObject({
      status: "executed",
      result: { output: { relationship: { status: "confirmed", effectConfirmed: true } } },
    });
    expect(await canExecute(org)).toBe(true);
    expect(await canExecute(otherOrg)).toBe(false);

    const deleted = await tenantA.submit({ operation: "delete", tuple: grantExecute });
    expect(deleted.body).toMatchObject({
      status: "executed",
      result: { output: { relationship: { status: "confirmed", revision: 2 } } },
    });
    expect(await canExecute(org)).toBe(false);

    // The tenant-A editor is not an editor in tenant B (cross-tenant fail closed).
    const tenantB = harness({ gateway, isEditor, organizationId: otherOrg });
    const crossTenant = await tenantB.submit({ operation: "write", tuple: grantExecute });
    expect(crossTenant.status).toBe(403);
    expect(await canExecute(otherOrg)).toBe(false);

    // Console path can never create admin membership, even for an editor.
    const escalation = await tenantA.submit({
      operation: "write",
      tuple: { user: String(outsider), relation: "editor", object: "authorization_admin:root" },
    });
    expect(escalation.status).toBe(422);
    expect(await isEditor(org, String(outsider))).toBe(false);
  });
});
