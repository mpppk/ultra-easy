import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  always,
  approve,
  authorityPrincipal,
  definePolicy,
  materializeApprovalPlan,
  principal,
  rule,
} from "@app/approval-core";
import type {
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalRuntimeState,
  ApprovalTaskId,
  ExecutorKey,
  MaterializedApprovalPlan,
  OrganizationId,
  PolicyEvaluationContext,
  SchemaKey,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";
import { createTicketActionRequest } from "@app/approval-core/testing";

import { D1ApprovalRuntimeProjectionRepository } from "./approval-runtime-projection-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { D1MaterializedPlanRepository } from "./materialized-plan-repository.ts";
import { D1PublicApiRepository } from "./public-api-repository.ts";

type SqlValue = string | number | bigint | Uint8Array | null;

function sqlValues(values: readonly unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    assert.fail(`SQLiteへbindできない値です: ${typeof value}`);
  });
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(readonly db: DatabaseSync) {}

  prepare(query: string): D1PreparedStatementLike {
    const statement = this.db.prepare(query);
    let values: unknown[] = [];
    const prepared: D1PreparedStatementLike = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return prepared;
      },
      async first<T>() {
        return (statement.get(...sqlValues(values)) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: statement.all(...sqlValues(values)) as T[] };
      },
      async run(): Promise<D1RunResultLike> {
        const result = statement.run(...sqlValues(values));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
    this.db.exec("BEGIN");
    const results: D1RunResultLike[] = [];
    for (const statement of statements) results.push(await statement.run());
    this.db.exec("COMMIT");
    return results;
  }
}

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:m6-d1");
const alice = branded<UserId>("user:alice");
const taskId = branded<ApprovalTaskId>("task:m6-d1");

function database(): SqliteD1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_materialized_plans.sql",
    "0002_approval_task_candidate_projections.sql",
    "0003_approval_runtime_projections.sql",
    "0004_action_requests_workflow_lookup.sql",
    "0005_action_results.sql",
    "0006_public_api.sql",
    "0014_api_idempotency_lease.sql",
    "0015_approval_command_delivery.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  return new SqliteD1Database(sqlite);
}

async function approvalPlan(): Promise<MaterializedApprovalPlan> {
  const request = createTicketActionRequest();
  const context: PolicyEvaluationContext = {
    ...request,
    actor: { type: "user", id: alice },
    authority: { principal: { type: "user", id: alice } },
    organization: { id: organizationId },
    now: "2026-09-19T00:00:00.000Z",
  };
  const definition: ActionDefinition = {
    key: branded<ActionDefinitionKey>("ticket-priority-change"),
    version: 1,
    actionType: context.action.type,
    inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
    executorKey: branded<ExecutorKey>("ticket-executor"),
  };
  const policyKey = branded<ApprovalPolicyKey>("policy:m6-d1");
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>("binding:m6-d1"),
    organizationId,
    policyKey,
    selector: { actionTypes: [context.action.type] },
    enabled: true,
  };
  const sources: VersionedApprovalPolicyBinding[] = [
    {
      binding,
      policyVersion: 1,
      policy: definePolicy({
        key: String(policyKey),
        name: "M6 D1",
        rules: [
          rule("default", {
            when: always(),
            flow: approve({
              key: "manager",
              approver: principal(authorityPrincipal()),
              resolution: "snapshot",
              candidateCompletion: "any",
            }),
          }),
        ],
      }),
    },
  ];
  const result = await materializeApprovalPlan({
    actionRequestId: branded<ActionRequestId>("action-request:m6-d1"),
    context,
    actionDefinition: definition,
    policyBindings: sources,
  });
  assert(result.type === "materialized", result.type === "error" ? result.message : undefined);
  return result.plan;
}

function runtimeState(plan: MaterializedApprovalPlan): ApprovalRuntimeState {
  assert(plan.flow.type === "approval");
  return {
    schemaVersion: 1,
    actionRequestId: plan.actionRequestId,
    approvalPlanChecksum: plan.approvalPlanChecksum,
    interpreterSemanticsVersion: plan.interpreterSemanticsVersion,
    status: "pending",
    startedAt: "2026-09-19T00:00:01.000Z",
    processedDecisionKeys: [],
    tasks: [
      {
        id: taskId,
        materializedStepId: plan.flow.materializedStepId,
        status: "pending",
        target: plan.flow.target,
        candidateUserIds: [alice],
        decisions: [],
        activatedAt: "2026-09-19T00:00:01.000Z",
        usedFallback: false,
      },
    ],
  };
}

describe("D1PublicApiRepository", () => {
  it("ActionRequest / task / inboxを既存projectionから再構成する", async () => {
    const db = database();
    const plan = await approvalPlan();
    const saved = await new D1MaterializedPlanRepository(db).save(plan);
    expect(saved.type).toBe("created");
    const projected = await new D1ApprovalRuntimeProjectionRepository(db).replace({
      organizationId,
      state: runtimeState(plan),
    });
    assert(Result.isSuccess(projected));

    const repository = new D1PublicApiRepository(db);
    const action = await repository.getActionRequest({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(action));
    expect(action.value).toMatchObject({
      id: String(plan.actionRequestId),
      status: "pending_approval",
      approval: { required: true, activeTaskCount: 1 },
    });

    const task = await repository.getApprovalTask({
      organizationId,
      taskId,
      viewerUserId: alice,
    });
    assert(Result.isSuccess(task));
    expect(task.value).toMatchObject({
      id: String(taskId),
      stepKey: "manager",
      canApprove: true,
      resolution: "snapshot",
    });

    const inbox = await repository.listMyApprovalTasks({
      organizationId,
      userId: alice,
      limit: 50,
      status: "pending",
    });
    assert(Result.isSuccess(inbox));
    expect(inbox.value.items.map((item) => item.id)).toEqual([String(taskId)]);
  });

  it("#83: Task候補者とDecision済みuserだけをActionRequestの関係者として判定する", async () => {
    const db = database();
    const plan = await approvalPlan();
    expect((await new D1MaterializedPlanRepository(db).save(plan)).type).toBe("created");
    const state = runtimeState(plan);
    state.tasks[0]!.decisions = [
      {
        idempotencyKey: "decided",
        taskId,
        userId: "user:carol" as UserId,
        decision: "reject",
        decidedAt: "2026-09-19T00:00:02.000Z",
      },
    ];
    const projected = await new D1ApprovalRuntimeProjectionRepository(db).replace({
      organizationId,
      state,
    });
    assert(Result.isSuccess(projected));

    const repository = new D1PublicApiRepository(db);
    const participant = async (userId: string, org: OrganizationId = organizationId) => {
      const result = await repository.isActionRequestParticipant({
        organizationId: org,
        actionRequestId: plan.actionRequestId,
        userId: userId as UserId,
      });
      assert(Result.isSuccess(result));
      return result.value;
    };
    expect(await participant(String(alice))).toBe(true);
    expect(await participant("user:carol")).toBe(true);
    expect(await participant("user:mallory")).toBe(false);
    expect(await participant(String(alice), "organization:other" as OrganizationId)).toBe(false);
  });

  it("Approval commandをpendingからappliedへ更新して再読込できる", async () => {
    const db = database();
    const repository = new D1PublicApiRepository(db);

    const created = await repository.createPending({
      command: {
        id: "command:m6-d1",
        organizationId: String(organizationId),
        actionRequestId: "action-request:m6-d1",
        taskId: String(taskId),
        type: "approve",
        status: "pending",
        createdAt: "2026-09-19T00:00:02.000Z",
      },
      actorUserId: alice,
      comment: "ok",
    });
    assert(Result.isSuccess(created));
    expect(created.value.type).toBe("created");

    const claimed = await repository.claim({
      organizationId,
      commandId: "command:m6-d1",
      now: "2026-09-19T00:00:02.500Z",
      leaseUntil: "2026-09-19T00:01:02.500Z",
    });
    assert(Result.isSuccess(claimed));
    expect(claimed.value?.command.id).toBe("command:m6-d1");
    const contended = await repository.claim({
      organizationId,
      commandId: "command:m6-d1",
      now: "2026-09-19T00:00:02.600Z",
      leaseUntil: "2026-09-19T00:01:02.600Z",
    });
    assert(Result.isSuccess(contended));
    expect(contended.value).toBeNull();

    const delivered = await repository.transition({
      organizationId,
      commandId: "command:m6-d1",
      from: ["pending"],
      to: "delivered",
    });
    assert(Result.isSuccess(delivered));
    expect(delivered.value).toMatchObject({
      type: "updated",
      record: { command: { status: "delivered" } },
    });

    const updated = await repository.transition({
      organizationId,
      commandId: "command:m6-d1",
      from: ["pending", "delivered"],
      to: "applied",
      appliedAt: "2026-09-19T00:00:03.000Z",
    });
    assert(Result.isSuccess(updated));
    expect(updated.value.type).toBe("updated");
    expect(updated.value.record.command).toMatchObject({
      id: "command:m6-d1",
      status: "applied",
      appliedAt: "2026-09-19T00:00:03.000Z",
    });

    const stale = await repository.transition({
      organizationId,
      commandId: "command:m6-d1",
      from: ["pending"],
      to: "failed",
    });
    assert(Result.isSuccess(stale));
    expect(stale.value).toMatchObject({
      type: "stale",
      record: { command: { status: "applied" } },
    });
  });

  it("#88: retriable失敗はattempt_count/next_attempt_atでbackoffし、期限到来後にorg横断で拾う", async () => {
    const db = database();
    const repository = new D1PublicApiRepository(db);
    for (const [id, org] of [
      ["command:quiet-org", "organization:quiet"],
      ["command:busy-org", String(organizationId)],
    ] as const) {
      const created = await repository.createPending({
        command: {
          id,
          organizationId: org,
          actionRequestId: "action-request:m6-d1",
          taskId: String(taskId),
          type: "approve",
          status: "pending",
          createdAt:
            id === "command:quiet-org" ? "2026-09-19T00:00:00.000Z" : "2026-09-19T00:00:01.000Z",
        },
        actorUserId: alice,
      });
      assert(Result.isSuccess(created));
    }

    const retry = await repository.scheduleRetry({
      organizationId,
      commandId: "command:busy-org",
      nextAttemptAt: "2026-09-19T00:05:00.000Z",
      error: {
        type: "urn:ultra-easy:problem:decision_workflow_send_failed",
        title: "retry",
        status: 503,
        code: "decision_workflow_send_failed",
      },
    });
    assert(Result.isSuccess(retry));
    expect(retry.value.record).toMatchObject({
      attemptCount: 1,
      nextAttemptAt: "2026-09-19T00:05:00.000Z",
      command: { status: "pending" },
    });

    const early = await repository.listDuePending({ now: "2026-09-19T00:01:00.000Z", limit: 10 });
    assert(Result.isSuccess(early));
    expect(early.value.map((record) => record.command.id)).toEqual(["command:quiet-org"]);
    const due = await repository.listDuePending({ now: "2026-09-19T00:05:00.000Z", limit: 10 });
    assert(Result.isSuccess(due));
    expect(due.value.map((record) => record.command.id)).toEqual([
      "command:quiet-org",
      "command:busy-org",
    ]);
  });

  it("Idempotency reservationをreplayし、異なるpayload hashはconflictにする", async () => {
    const db = database();
    const repository = new D1PublicApiRepository(db);
    const base = {
      organizationId,
      operation: "action-request:create",
      key: "idem:m6",
      requestHash: "sha256:first",
      status: "pending" as const,
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    };

    const acquired = await repository.reserve(base);
    assert(Result.isSuccess(acquired));
    expect(acquired.value.type).toBe("acquired");

    const completed = await repository.complete({
      organizationId,
      operation: base.operation,
      key: base.key,
      requestHash: base.requestHash,
      responseStatus: 201,
      responseBody: { id: "action-request:m6-d1" },
      responseLocation: "/action-request:m6-d1",
      completedAt: "2026-09-19T00:00:01.000Z",
    });
    assert(Result.isSuccess(completed));

    const replay = await repository.reserve({
      ...base,
      updatedAt: "2026-09-19T00:00:02.000Z",
    });
    assert(Result.isSuccess(replay));
    expect(replay.value).toMatchObject({
      type: "replay",
      record: {
        responseStatus: 201,
        responseBody: { id: "action-request:m6-d1" },
      },
    });

    const conflict = await repository.reserve({
      ...base,
      requestHash: "sha256:second",
      updatedAt: "2026-09-19T00:00:03.000Z",
    });
    assert(Result.isSuccess(conflict));
    expect(conflict.value.type).toBe("conflict");
  });

  it("#92: pending予約はlease中in_progress、期限切れ / lease未設定なら同じrequestが引き継ぐ", async () => {
    const db = database();
    const repository = new D1PublicApiRepository(db);
    const base = {
      organizationId,
      operation: "action-request:create",
      key: "idem:lease",
      requestHash: "sha256:first",
      status: "pending" as const,
      lockedUntil: "2026-09-19T00:01:00.000Z",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    };

    const acquired = await repository.reserve(base);
    const locked = await repository.reserve({ ...base, updatedAt: "2026-09-19T00:00:30.000Z" });
    const otherPayload = await repository.reserve({
      ...base,
      requestHash: "sha256:second",
      updatedAt: "2026-09-19T00:02:00.000Z",
    });
    const takenOver = await repository.reserve({
      ...base,
      lockedUntil: "2026-09-19T00:03:00.000Z",
      updatedAt: "2026-09-19T00:02:00.000Z",
    });
    const raced = await repository.reserve({
      ...base,
      lockedUntil: "2026-09-19T00:03:00.000Z",
      updatedAt: "2026-09-19T00:02:00.000Z",
    });

    assert(Result.isSuccess(acquired) && Result.isSuccess(locked));
    expect(acquired.value.type).toBe("acquired");
    expect(locked.value.type).toBe("in_progress");
    assert(Result.isSuccess(otherPayload));
    expect(otherPayload.value.type).toBe("conflict");
    assert(Result.isSuccess(takenOver) && Result.isSuccess(raced));
    expect(takenOver.value).toMatchObject({
      type: "acquired",
      record: { lockedUntil: "2026-09-19T00:03:00.000Z" },
    });
    expect(raced.value.type).toBe("in_progress");

    // lease導入前のpending（locked_until NULL）も永久in_progressにしない。
    db.db
      .prepare("UPDATE api_idempotency_keys SET locked_until = NULL WHERE idempotency_key = ?")
      .run("idem:lease");
    const legacy = await repository.reserve({ ...base, updatedAt: "2026-09-19T00:02:30.000Z" });
    assert(Result.isSuccess(legacy));
    expect(legacy.value.type).toBe("acquired");
  });

  it("#92: releaseしたpending予約は同じkeyで再予約できる", async () => {
    const repository = new D1PublicApiRepository(database());
    const base = {
      organizationId,
      operation: "action-request:create",
      key: "idem:release",
      requestHash: "sha256:first",
      status: "pending" as const,
      lockedUntil: "2026-09-19T00:01:00.000Z",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    };

    await repository.reserve(base);
    await repository.release(base);
    const again = await repository.reserve(base);

    assert(Result.isSuccess(again));
    expect(again.value.type).toBe("acquired");
  });

  it("AC-M7-001: ActionRequest/task/command/idempotencyをorganization境界で分離する", async () => {
    const db = database();
    const plan = await approvalPlan();
    const saved = await new D1MaterializedPlanRepository(db).save(plan);
    expect(saved.type).toBe("created");
    const projected = await new D1ApprovalRuntimeProjectionRepository(db).replace({
      organizationId,
      state: runtimeState(plan),
    });
    assert(Result.isSuccess(projected));

    const repository = new D1PublicApiRepository(db);
    const otherOrganizationId = branded<OrganizationId>("org:other");

    const action = await repository.getActionRequest({
      organizationId: otherOrganizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(action));
    expect(action.value).toBeNull();

    const task = await repository.getApprovalTask({
      organizationId: otherOrganizationId,
      taskId,
      viewerUserId: alice,
    });
    assert(Result.isSuccess(task));
    expect(task.value).toBeNull();

    const command = await repository.createPending({
      command: {
        id: "command:tenant-boundary",
        organizationId: String(organizationId),
        actionRequestId: String(plan.actionRequestId),
        taskId: String(taskId),
        type: "approve",
        status: "pending",
        createdAt: "2026-09-19T00:00:02.000Z",
      },
      actorUserId: alice,
    });
    assert(Result.isSuccess(command));
    const crossCommand = await repository.load({
      organizationId: otherOrganizationId,
      commandId: "command:tenant-boundary",
    });
    assert(Result.isSuccess(crossCommand));
    expect(crossCommand.value).toBeNull();

    const first = await repository.reserve({
      organizationId,
      operation: "same-operation",
      key: "same-key",
      requestHash: "sha256:same",
      status: "pending",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
    assert(Result.isSuccess(first));
    const otherTenant = await repository.reserve({
      organizationId: otherOrganizationId,
      operation: "same-operation",
      key: "same-key",
      requestHash: "sha256:different",
      status: "pending",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
    assert(Result.isSuccess(otherTenant));
    expect(otherTenant.value.type).toBe("acquired");
  });
});
