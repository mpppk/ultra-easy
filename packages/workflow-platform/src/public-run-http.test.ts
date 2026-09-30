import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  HttpTrustedContextError,
  type ActionRequestView,
  type ApprovalReadRepository,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import type { ActionRequestId, OrganizationId, PrincipalRef, UserId } from "@app/approval-core";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import type { WorkflowRunRecord } from "@app/workflow-application";
import type { WorkflowVersion } from "@app/workflow-core";
import {
  D1ChildActionCorrelationRepository,
  D1WorkflowRunRepository,
  D1WorkflowVersionRepository,
} from "@app/workflow-d1";

import { createPublicWorkflowRunApi } from "./public-run-http.ts";
import type { WorkflowPlatform } from "./platform.ts";

const organizationId = "org:public-run" as OrganizationId;
const otherOrganizationId = "org:other" as OrganizationId;
const actionRequestId = "action-request:public-run" as ActionRequestId;
const childActionRequestId = "action-request:child" as ActionRequestId;
const runId = "wfrun:public-run";
const alice: PrincipalRef = { type: "user", id: "user:alice" as UserId };
const bob: PrincipalRef = { type: "user", id: "user:bob" as UserId };
const charlie: PrincipalRef = { type: "user", id: "user:charlie" as UserId };
const admin: PrincipalRef = { type: "user", id: "user:admin" as UserId };
const secret = "TOP_SECRET_SANDBOX_TOKEN";

function actionView(): ActionRequestView {
  return {
    id: actionRequestId,
    organizationId,
    actor: alice,
    authorityPrincipal: alice,
    action: {
      type: "knowledge.publish_document" as ActionRequestView["action"]["type"],
      resource: {
        type: "knowledge_page" as ActionRequestView["action"]["resource"]["type"],
        id: "page:one" as ActionRequestView["action"]["resource"]["id"],
      },
      input: { secret },
    },
    origin: "api",
    status: "executing",
    correlation: { spaceId: "space:one", pageId: "page:one" },
    approval: { required: false },
    checksums: {
      actionFingerprint: "fingerprint",
      evaluationSnapshotChecksum: "snapshot",
      approvalPlanChecksum: "approval",
    },
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:01.000Z",
  };
}

function childActionView(): ActionRequestView {
  return {
    ...actionView(),
    id: childActionRequestId,
    action: {
      ...actionView().action,
      type: "knowledge.search.reindex" as ActionRequestView["action"]["type"],
    },
    status: "pending_approval",
  };
}

async function harness() {
  const db = migratedSqliteD1();
  db.db
    .prepare(
      `INSERT INTO action_requests
      (id, organization_id, action_fingerprint, evaluation_snapshot,
       evaluation_snapshot_checksum, policy_binding_snapshots, materialized_plan,
       approval_plan_checksum, approval_binding_fingerprint,
       interpreter_semantics_version, created_at, correlation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actionRequestId,
      organizationId,
      "fingerprint",
      "{}",
      "snapshot",
      "[]",
      "{}",
      "approval",
      "binding",
      1,
      "2026-09-30T00:00:00.000Z",
      JSON.stringify({ spaceId: "space:one", pageId: "page:one" }),
    );
  const versions = new D1WorkflowVersionRepository(db);
  const runs = new D1WorkflowRunRepository(db);
  const correlations = new D1ChildActionCorrelationRepository(db);
  const version = {
    definitionId: "wf:public-run",
    version: 1,
    checksum: "sha256:public-run",
    definition: {
      id: "wf:public-run",
      name: "Publish",
      graph: { nodes: [{ id: "start", type: "trigger", label: "Start" }], edges: [] },
    },
    publishedAt: "2026-09-30T00:00:00.000Z",
    publishedBy: alice,
  } as unknown as WorkflowVersion;
  await versions.save({ organizationId, version });
  const record = {
    state: {
      runId,
      organizationId,
      definitionId: version.definitionId,
      version: 1,
      checksum: version.checksum,
      status: "failed",
      input: { secret },
      variables: { secret },
      context: { actor: alice, organizationSettings: {}, attributes: {} },
      scopes: {},
      nodeRuns: {
        "root:start": {
          id: "root:start",
          scopeId: "root",
          nodeId: "start",
          type: "trigger",
          status: "failed",
          attempt: 1,
          error: { code: secret, message: secret },
        },
      },
      edges: {},
      decisions: [],
      effects: {
        "effect:input": {
          id: "effect:input",
          nodeRunId: "root:start",
          request: { kind: "human_input", prompt: secret },
          status: "requested",
          requestedAt: "2026-09-30T00:00:00.000Z",
        },
      },
      error: { code: secret, message: secret, nodeRunId: "root:start" },
      counters: { nodeRuns: 1 },
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:01.000Z",
    },
    invocation: {
      actor: alice,
      authority: { principal: alice },
      origin: { type: "api" },
      parentAction: {
        actionRequestId,
        actionFingerprint: "fingerprint",
        idempotencyKey: "key",
        executionRef: runId,
      },
    },
    revision: 1,
    depth: 0,
    completionDelivered: false,
  } as unknown as WorkflowRunRecord;
  await runs.create({
    record,
    events: [
      {
        organizationId,
        runId: record.state.runId,
        eventKey: "event:secret",
        type: "node.failed",
        occurredAt: "2026-09-30T00:00:01.000Z",
        data: { secret },
      },
    ],
  });
  db.db
    .prepare(
      `INSERT INTO workflow_child_actions
      (organization_id, child_action_request_id, run_id, node_run_id, effect_id,
       parent_action_request_id, depth, ancestry_json, action_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      organizationId,
      childActionRequestId,
      runId,
      "root:start",
      "effect:child",
      actionRequestId,
      0,
      "[]",
      "knowledge.search.reindex",
      "2026-09-30T00:00:00.000Z",
    );
  db.db
    .prepare(
      `INSERT INTO approval_tasks
      (organization_id, task_id, action_request_id, materialized_step_id, status,
       candidate_user_ids, decisions, activated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      organizationId,
      "task:child",
      childActionRequestId,
      "step:child",
      "pending",
      JSON.stringify([String(bob.id)]),
      "[]",
      "2026-09-30T00:00:00.000Z",
    );

  const readRepository = {
    getActionRequest: async (input: {
      organizationId: OrganizationId;
      actionRequestId: ActionRequestId;
    }) =>
      Result.succeed(
        input.organizationId === organizationId && input.actionRequestId === actionRequestId
          ? actionView()
          : input.organizationId === organizationId &&
              input.actionRequestId === childActionRequestId
            ? childActionView()
            : null,
      ),
    isActionRequestParticipant: async (input: { organizationId: OrganizationId; userId: UserId }) =>
      Result.succeed(input.organizationId === organizationId && input.userId === bob.id),
  } as unknown as ApprovalReadRepository;
  const identityProvider: PublicHttpIdentityProvider = {
    authenticate: async ({ request, actionType }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (token === "scope-denied" && actionType) {
        return Result.fail(
          new HttpTrustedContextError(403, "client_operation_not_allowed", "Forbidden"),
        );
      }
      if (token === "alice") return Result.succeed(alice);
      if (token === "bob") return Result.succeed(bob);
      if (token === "admin") return Result.succeed(admin);
      if (token === "scope-denied") return Result.succeed(alice);
      if (token === "charlie") return Result.succeed(charlie);
      return Result.fail(
        new HttpTrustedContextError(401, "authentication_required", "Authentication required"),
      );
    },
  };
  const platform = { repositories: { runs, versions, correlations } } as WorkflowPlatform;
  const api = createPublicWorkflowRunApi({
    db,
    platform,
    readRepository,
    identityProvider,
    operatorAccess: {
      canReadAll: async ({ principal }) => Result.succeed(principal.id === admin.id),
    },
  });
  return { api };
}

function request(path: string, viewer: string): Request {
  return new Request(`https://api.example.test${path}`, {
    headers: { authorization: `Bearer ${viewer}` },
  });
}

describe("public Workflow Run API", () => {
  it("run ID・ActionRequest ID・space correlationで同じallowlisted viewを返す", async () => {
    const { api } = await harness();
    const base = `/v1/organizations/${organizationId}`;
    const byRun = await api.fetch(request(`${base}/workflow-runs/${runId}`, "alice"));
    expect(byRun.status).toBe(200);
    const view = await byRun.json();
    expect(view).toMatchObject({
      id: runId,
      actionRequestId,
      correlation: { spaceId: "space:one" },
      nodes: [{ key: "root:start", label: "Start", status: "failed", errorCode: "node_failed" }],
      childActions: [
        {
          actionRequestId: childActionRequestId,
          status: "waiting_approval",
          approvalTaskId: "task:child",
        },
      ],
      approvals: [{ taskId: "task:child", candidateIds: [String(bob.id)], status: "pending" }],
      humanInputs: [{ key: "effect:input", status: "waiting" }],
      failure: { code: "workflow_failed", message: "Workflow failed" },
    });
    expect(JSON.stringify(view)).not.toContain(secret);
    const byAction = await api.fetch(
      request(`${base}/action-requests/${actionRequestId}/workflow-run`, "alice"),
    );
    expect(((await byAction.json()) as { id: string }).id).toBe(runId);
    const list = await api.fetch(
      request(`${base}/workflow-runs?correlationKey=spaceId&correlationValue=space%3Aone`, "alice"),
    );
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
    const otherSpace = await api.fetch(
      request(
        `${base}/workflow-runs?correlationKey=spaceId&correlationValue=space%3Aother`,
        "alice",
      ),
    );
    expect(((await otherSpace.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("requester・承認参加者・operator以外にはrunを秘匿する", async () => {
    const { api } = await harness();
    const base = `/v1/organizations/${organizationId}`;
    expect((await api.fetch(request(`${base}/workflow-runs/${runId}`, "bob"))).status).toBe(200);
    expect((await api.fetch(request(`${base}/workflow-runs/${runId}`, "admin"))).status).toBe(200);
    expect((await api.fetch(request(`${base}/workflow-runs/${runId}`, "charlie"))).status).toBe(
      404,
    );
    const list = await api.fetch(request(`${base}/workflow-runs`, "charlie"));
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
    expect(
      (await api.fetch(request(`${base}/workflow-runs/${runId}`, "scope-denied"))).status,
    ).toBe(403);
    expect((await api.fetch(request(`${base}/workflow-runs`, "scope-denied"))).status).toBe(200);
    expect(
      (
        (await (await api.fetch(request(`${base}/workflow-runs`, "scope-denied"))).json()) as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);
  });

  it("別tenantのrunをIDからも一覧からも返さない", async () => {
    const { api } = await harness();
    const base = `/v1/organizations/${otherOrganizationId}`;
    expect((await api.fetch(request(`${base}/workflow-runs/${runId}`, "alice"))).status).toBe(404);
    expect(
      (await api.fetch(request(`${base}/action-requests/${actionRequestId}/workflow-run`, "alice")))
        .status,
    ).toBe(404);
    const list = await api.fetch(request(`${base}/workflow-runs`, "alice"));
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("不正なpath encodingを一覧routeとして扱わない", async () => {
    const { api } = await harness();
    const response = await api.fetch(
      request(`/v1/organizations/${organizationId}/workflow-runs/%E0%A4%A`, "alice"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "invalid_path_parameter",
    });
  });
});
