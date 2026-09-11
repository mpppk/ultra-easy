import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

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
  ApprovalPlanChecksum,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ExecutorKey,
  MaterializedApprovalPlan,
  OrganizationId,
  PolicyEvaluationContext,
  SchemaKey,
} from "@app/approval-core";
import { createTicketActionRequest } from "@app/approval-core/testing";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { D1MaterializedPlanRepository } from "./materialized-plan-repository.ts";

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
    throw new Error(`SQLiteへbindできない値です: ${typeof value}`);
  });
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(private readonly db: DatabaseSync) {}

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
      async run(): Promise<D1RunResultLike> {
        const result = statement.run(...sqlValues(values));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }
}

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:test");

function context(threshold = 10): PolicyEvaluationContext {
  const request = createTicketActionRequest();
  return {
    ...request,
    organization: { id: organizationId, settings: { threshold } },
    now: "2026-09-11T00:00:00.000Z",
  };
}

function actionDefinition(contextValue: PolicyEvaluationContext): ActionDefinition {
  return {
    key: branded<ActionDefinitionKey>("ticket-priority-change"),
    version: 1,
    actionType: contextValue.action.type,
    inputSchema: { key: branded<SchemaKey>("ticket-priority-input"), version: 1 },
    executorKey: branded<ExecutorKey>("ticket-priority-executor"),
  };
}

async function createPlan(input: {
  actionRequestId: string;
  policyVersion?: number;
  threshold?: number;
}) {
  const contextValue = context(input.threshold);
  const policyKey = branded<ApprovalPolicyKey>("policy:ticket");
  const policy = definePolicy({
    key: String(policyKey),
    name: "Ticket Policy",
    rules: [
      rule("default", {
        when: always(),
        flow: approve({
          key: "owner",
          approver: principal(authorityPrincipal()),
        }),
      }),
    ],
  });
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>("binding:ticket"),
    organizationId,
    policyKey,
    selector: { actionTypes: [contextValue.action.type] },
    enabled: true,
  };
  const result = await materializeApprovalPlan({
    actionRequestId: branded<ActionRequestId>(input.actionRequestId),
    context: contextValue,
    actionDefinition: actionDefinition(contextValue),
    policyBindings: [{ binding, policyVersion: input.policyVersion ?? 1, policy }],
  });
  if (result.type !== "materialized") throw new Error(result.message);
  return result.plan;
}

function createRepository(): {
  repository: D1MaterializedPlanRepository;
  sqlite: DatabaseSync;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../migrations/0001_materialized_plans.sql", import.meta.url), "utf8"),
  );
  return {
    repository: new D1MaterializedPlanRepository(new SqliteD1Database(sqlite)),
    sqlite,
  };
}

describe("D1MaterializedPlanRepository", () => {
  it("Materialized Planを保存・再読込してsemantic identityを保持する", async () => {
    const { repository } = createRepository();
    const plan = await createPlan({ actionRequestId: "action-request:1" });

    await expect(repository.save(plan)).resolves.toEqual({ type: "created" });
    await expect(repository.save(plan)).resolves.toEqual({ type: "existing" });

    const loaded = await repository.load({
      organizationId,
      actionRequestId: plan.actionRequestId,
      expectedApprovalPlanChecksum: plan.approvalPlanChecksum,
    });
    expect(loaded.type).toBe("found");
    if (loaded.type !== "found") return;
    expect(loaded.plan).toEqual(plan);
  });

  it("AC-M2-006: expected approvalPlanChecksumが違えばPlanを返さない", async () => {
    const { repository } = createRepository();
    const plan = await createPlan({ actionRequestId: "action-request:2" });
    await repository.save(plan);

    const loaded = await repository.load({
      organizationId,
      actionRequestId: plan.actionRequestId,
      expectedApprovalPlanChecksum: branded<ApprovalPlanChecksum>(`sha256:${"0".repeat(64)}`),
    });

    expect(loaded).toEqual({
      type: "checksum_mismatch",
      actualApprovalPlanChecksum: plan.approvalPlanChecksum,
    });
  });

  it("同じActionRequest IDへ異なるPlanを上書きしない", async () => {
    const { repository } = createRepository();
    const first = await createPlan({ actionRequestId: "action-request:3", policyVersion: 1 });
    const second = await createPlan({ actionRequestId: "action-request:3", policyVersion: 2 });

    await expect(repository.save(first)).resolves.toEqual({ type: "created" });
    await expect(repository.save(second)).resolves.toEqual({
      type: "conflict",
      existingApprovalPlanChecksum: first.approvalPlanChecksum,
    });
  });

  it("Approval Planが同じでもEvaluation Snapshotが異なればexisting扱いしない", async () => {
    const { repository } = createRepository();
    const first = await createPlan({ actionRequestId: "action-request:4", threshold: 10 });
    const second = await createPlan({ actionRequestId: "action-request:4", threshold: 20 });

    expect(first.approvalPlanChecksum).toBe(second.approvalPlanChecksum);
    expect(first.approvalBindingFingerprint).not.toBe(second.approvalBindingFingerprint);
    await expect(repository.save(first)).resolves.toEqual({ type: "created" });
    await expect(repository.save(second)).resolves.toEqual({
      type: "conflict",
      existingApprovalPlanChecksum: first.approvalPlanChecksum,
    });
  });

  it("semantic verificationに失敗するPlanは保存しない", async () => {
    const { repository } = createRepository();
    const plan = structuredClone(await createPlan({ actionRequestId: "action-request:5" }));
    plan.approvalPlanChecksum = branded<ApprovalPlanChecksum>(`sha256:${"0".repeat(64)}`);

    await expect(repository.save(plan)).resolves.toMatchObject({ type: "invalid_plan" });
  });

  it("DB検索キーとPlan内部identityが不一致ならcross-tenant Planを返さない", async () => {
    const { repository, sqlite } = createRepository();
    const plan = await createPlan({ actionRequestId: "action-request:6" });
    await repository.save(plan);

    const corrupted = structuredClone(plan) as MaterializedApprovalPlan;
    corrupted.organizationId = branded<OrganizationId>("org:other");
    sqlite
      .prepare(
        "UPDATE action_requests SET materialized_plan = ? WHERE organization_id = ? AND id = ?",
      )
      .run(JSON.stringify(corrupted), String(organizationId), String(plan.actionRequestId));

    await expect(
      repository.load({ organizationId, actionRequestId: plan.actionRequestId }),
    ).resolves.toMatchObject({ type: "invalid_plan" });
  });
});
