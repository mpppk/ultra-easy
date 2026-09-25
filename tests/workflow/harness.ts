import { Result } from "@praha/byethrow";
import { expect } from "vite-plus/test";

import {
  actionEventRecord,
  actionExecutionOutcomeEvents,
  approve as approveFlow,
  asyncExecutionAcceptedEvents,
  authorityPrincipal,
  always,
  definePolicy,
  executeAuthorizedAction,
  foldActionRequestStatus,
  principal,
  reauthorizeActionForExecution,
  rule,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionRequest,
  ActionRequestId,
  ActionRequestStatus,
  ActionType,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  Condition,
  ExecutorKey,
  JsonObject,
  MaterializedApprovalPlan,
  OrganizationId,
  PrincipalRef,
  SchemaKey,
  SchemaResolver,
  UserId,
} from "@app/approval-core";
import type { ActionWorkflowStarter } from "@app/approval-application";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import type { SqliteD1Database } from "@app/approval-d1/testing";
import { createWorkflowPlatform } from "@app/workflow-platform";
import type { WorkflowPlatform, WorkflowPlatformOptions } from "@app/workflow-platform";
import type { D1DatabaseLike, D1PreparedStatementLike, D1RunResultLike } from "@app/workflow-d1";
import type { WorkflowDefinition, WorkflowRunId } from "@app/workflow-core";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export function branded<T extends string>(value: string): T {
  return value as T;
}

export const ORG = branded<OrganizationId>("org:workflow-e2e");
export const ALICE: PrincipalRef = { type: "user", id: branded<UserId>("user:alice") };
export const PRIMITIVE_EXECUTOR_KEY = "primitive";

export class ManualClock {
  constructor(public value = "2026-09-25T00:00:00.000Z") {}
  now(): string {
    return this.value;
  }
  advance(seconds: number): void {
    this.value = new Date(Date.parse(this.value) + seconds * 1000).toISOString();
  }
}

class FaultInjectingStatement implements D1PreparedStatementLike {
  constructor(
    readonly query: string,
    readonly inner: D1PreparedStatementLike,
    private readonly faults: FaultInjectingD1,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.inner.bind(...values);
    return this;
  }

  first<T>(): Promise<T | null> {
    return this.inner.first<T>();
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.inner.all ? this.inner.all<T>() : { results: [] };
  }

  run(): Promise<D1RunResultLike> {
    return this.faults.guard([this.query]) ?? this.inner.run();
  }
}

/**
 * process crashの代役: SQLに`match`を含む書き込みを、commit前に指定回数だけ失敗させる。
 * batchはD1と同じくatomicなので、失敗したbatchの書き込みは一切残らない。
 */
export class FaultInjectingD1 implements D1DatabaseLike {
  private readonly faults: { match: string; skip: number; remaining: number }[] = [];
  readonly crashes: string[] = [];

  constructor(private readonly inner: D1DatabaseLike) {}

  /** `skip`回目までの一致は通し、その後`times`回だけ落とす。 */
  crashOn(match: string, options: { times?: number; skip?: number } = {}): void {
    this.faults.push({ match, skip: options.skip ?? 0, remaining: options.times ?? 1 });
  }

  guard(queries: readonly string[]): Promise<never> | null {
    const fault = this.faults.find(
      (candidate) =>
        candidate.remaining > 0 && queries.some((query) => query.includes(candidate.match)),
    );
    if (!fault) return null;
    if (fault.skip > 0) {
      fault.skip -= 1;
      return null;
    }
    fault.remaining -= 1;
    this.crashes.push(fault.match);
    return Promise.reject(new Error(`injected crash before commit: ${fault.match}`));
  }

  prepare(query: string): D1PreparedStatementLike {
    return new FaultInjectingStatement(query, this.inner.prepare(query), this);
  }

  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
    const unwrapped = statements.map((statement) =>
      statement instanceof FaultInjectingStatement ? statement : null,
    );
    return (
      this.guard(unwrapped.map((statement) => statement?.query ?? "")) ??
      this.inner.batch(statements.map((statement, index) => unwrapped[index]?.inner ?? statement))
    );
  }
}

/** primitive Actionの外部side effect sink。呼ばれた（= 実行された）ActionRequestを記録する。 */
export class RecordingExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  readonly calls: ActionExecutionRequest[] = [];

  async execute(request: ActionExecutionRequest) {
    this.calls.push(structuredClone(request));
    const result: ActionExecutionResult = {
      status: "succeeded",
      output: {
        actionType: String(request.action.type),
        resourceId: String(request.action.resource.id),
        input: request.action.input,
      },
    };
    return Result.succeed(result);
  }
}

/** action typeごとにallow / denyする認可（delegation chainの構造検証はcoreが行う）。 */
export class TableAuthorizer implements ActionAuthorizer {
  readonly denied = new Set<string>();
  readonly checks: ActionRequest[] = [];

  async check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: "minimize_latency" | "higher_consistency";
  }) {
    this.checks.push(structuredClone(input.request));
    if (this.denied.has(String(input.request.action.type))) {
      return Result.succeed({
        type: "deny" as const,
        code: "permission_denied",
        reason: `${String(input.request.action.type)} is not allowed`,
      });
    }
    return Result.succeed({
      type: "allow" as const,
      evidence: {
        evaluatedAt: input.evaluatedAt,
        consistency: input.consistency,
        provider: "table-authorizer",
      },
    });
  }
}

/** 承認が必要なActionRequestを記録するだけのstarter（承認はtestが`approve` / `reject`で行う）。 */
export class RecordingApprovalStarter implements ActionWorkflowStarter {
  readonly started: MaterializedApprovalPlan[] = [];

  async start(input: { plan: MaterializedApprovalPlan; startedAt: string }) {
    this.started.push(input.plan);
    return Result.succeed({ workflowInstanceId: `approval:${String(input.plan.actionRequestId)}` });
  }
}

const anyObjectSchema = {
  "~standard": {
    version: 1,
    vendor: "workflow-e2e",
    validate(value: unknown) {
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "input must be an object" }] };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

const anyObjectSchemaResolver: SchemaResolver = {
  resolve: async () => Result.succeed(anyObjectSchema),
};

export type WorkflowHarness = Awaited<ReturnType<typeof createWorkflowHarness>>;

export async function createWorkflowHarness(
  options: {
    primitiveActionTypes?: string[];
    platform?: Partial<Omit<WorkflowPlatformOptions, "db" | "organizationId" | "clock">>;
  } = {},
) {
  const db: SqliteD1Database = migratedSqliteD1();
  const faults = new FaultInjectingD1(db);
  const clock = new ManualClock();
  const executor = new RecordingExecutor();
  const authorizer = new TableAuthorizer();
  const approvals = new RecordingApprovalStarter();
  const platform: WorkflowPlatform = createWorkflowPlatform({
    db: faults,
    organizationId: ORG,
    clock,
    authorizer,
    primitiveExecutors: { [PRIMITIVE_EXECUTOR_KEY]: executor },
    workflowStarter: approvals,
    schemaResolver: anyObjectSchemaResolver,
    pollIntervalSeconds: 5,
    ...options.platform,
  });

  for (const actionType of options.primitiveActionTypes ?? []) {
    const definition: ActionDefinition = {
      key: branded<ActionDefinitionKey>(`primitive:${actionType}`),
      version: 1,
      actionType: branded<ActionType>(actionType),
      inputSchema: { key: branded<SchemaKey>(`schema:${actionType}`), version: 1 },
      executorKey: branded<ExecutorKey>(PRIMITIVE_EXECUTOR_KEY),
    };
    await platform.catalog.publish({
      organizationId: ORG,
      definition,
      publishedBy: ALICE,
      publishedAt: clock.now(),
    });
  }

  let policyCounter = 0;

  /** action typeにApproval Policy（authority principalの承認）を適用する。 */
  async function requireApproval(actionType: string, when?: Condition) {
    policyCounter += 1;
    const policyKey = branded<ApprovalPolicyKey>(`policy:${actionType}:${policyCounter}`);
    const source = branded<ActionRequestId>(`bootstrap:${policyCounter}`);
    const published = await platform.governance.publishApprovalPolicy({
      organizationId: ORG,
      sourceActionRequestId: source,
      actor: ALICE,
      occurredAt: clock.now(),
      version: 1,
      policy: definePolicy({
        key: String(policyKey),
        name: `approval for ${actionType}`,
        rules: [
          rule("approve", {
            when: always(),
            flow: approveFlow({ key: "owner", approver: principal(authorityPrincipal()) }),
          }),
        ],
      }),
    });
    expect(Result.isSuccess(published)).toBe(true);
    const bound = await platform.governance.updateApprovalPolicyBinding({
      organizationId: ORG,
      sourceActionRequestId: source,
      actor: ALICE,
      occurredAt: clock.now(),
      binding: {
        id: branded<ApprovalPolicyBindingId>(`binding:${actionType}:${policyCounter}`),
        organizationId: ORG,
        policyKey,
        selector: { actionTypes: [branded<ActionType>(actionType)], ...(when ? { when } : {}) },
        enabled: true,
      },
    });
    expect(Result.isSuccess(bound)).toBe(true);
  }

  async function publish(definition: WorkflowDefinition, actionType?: string) {
    const published = await platform.publishing.publish({
      organizationId: ORG,
      definition,
      publishedBy: ALICE,
      now: clock.now(),
      ...(actionType ? { actionType } : {}),
    });
    if (Result.isFailure(published)) {
      expect.fail(`${published.error.message} ${JSON.stringify(published.error.issues ?? [])}`);
    }
    return published.value;
  }

  async function submit(
    actionType: string,
    input: JsonObject,
    resourceId = "res-1",
    actor: PrincipalRef = ALICE,
  ) {
    const submitted = await platform.service.submit({
      action: {
        type: branded<ActionType>(actionType),
        resource: { type: branded("employee"), id: branded(resourceId) },
        input,
      },
      trustedContext: {
        actor,
        authority: { principal: actor },
        origin: { type: "api" },
        organization: { id: ORG, settings: { approvalLimit: 10_000 } },
        now: clock.now(),
      },
    });
    if (Result.isFailure(submitted))
      expect.fail(`${submitted.error.code}: ${submitted.error.message}`);
    if (submitted.value.type !== "accepted")
      expect.fail(`authorization denied: ${submitted.value.reason}`);
    return submitted.value;
  }

  async function status(actionRequestId: ActionRequestId): Promise<ActionRequestStatus | null> {
    const loaded = await platform.statuses.status({ organizationId: ORG, actionRequestId });
    if (Result.isFailure(loaded)) expect.fail(loaded.error.message);
    return loaded.value?.status ?? null;
  }

  /** wakeAtが来たrunを収束するまで進める（Cloudflare runner / cron sweeperの代役）。 */
  async function settle(rounds = 10) {
    for (let round = 0; round < rounds; round += 1) {
      const due = await platform.repositories.runs.listDue({
        now: "2999-01-01T00:00:00.000Z",
        limit: 100,
      });
      if (Result.isFailure(due)) expect.fail(due.error.message);
      if (due.value.length === 0) return;
      for (const key of due.value) await platform.runtime.advance(key);
    }
  }

  async function loadPlan(actionRequestId: ActionRequestId) {
    const plan = await platform.repositories.plans.load({ organizationId: ORG, actionRequestId });
    if (plan.type !== "found") expect.fail(`plan not found: ${plan.type}`);
    return plan.plan;
  }

  /** 承認済みとして、Durable Approval Workflowと同じ再認可 → 実行 → 結果記録を行う。 */
  async function approve(actionRequestId: ActionRequestId) {
    const plan = await loadPlan(actionRequestId);
    const now = clock.now();
    await platform.repositories.events.appendMany([
      actionEventRecord({
        organizationId: ORG,
        occurredAt: now,
        event: { type: "approval.approved", actionRequestId },
      }),
    ]);
    const request: ActionRequest = {
      actor: plan.evaluationSnapshot.actor,
      authority: plan.evaluationSnapshot.authority,
      origin: plan.evaluationSnapshot.origin,
      action: { type: plan.action.type, resource: plan.action.resource, input: plan.action.input },
    };
    const reauthorized = await reauthorizeActionForExecution({
      authorizer,
      request,
      evaluatedAt: now,
    });
    if (Result.isFailure(reauthorized)) expect.fail(reauthorized.error.message);
    if (reauthorized.value.type === "authorization_revoked") {
      await platform.repositories.results.save(
        { organizationId: ORG, actionRequestId, status: "authorization_revoked", completedAt: now },
        actionExecutionOutcomeEvents({
          organizationId: ORG,
          actionRequestId,
          status: "authorization_revoked",
          completedAt: now,
        }),
      );
    } else {
      const executed = await executeAuthorizedAction({
        executor: platform.registry,
        organizationId: ORG,
        actionRequestId,
        actionFingerprint: plan.actionFingerprint,
        action: plan.action,
        authorizationEvidence: reauthorized.value.authorizationEvidence,
        actor: plan.evaluationSnapshot.actor,
      });
      if (Result.isFailure(executed)) expect.fail(executed.error.message);
      if (executed.value.type === "accepted") {
        await platform.repositories.asyncExecutions.accept({
          record: {
            organizationId: ORG,
            actionRequestId,
            actionFingerprint: plan.actionFingerprint,
            executionRef: executed.value.executionRef,
            idempotencyKey: executed.value.idempotencyKey,
            executorKey: plan.action.definition.executorKey,
            guaranteeLevel: executed.value.guaranteeLevel,
            status: "accepted",
            acceptedAt: now,
          },
          events: asyncExecutionAcceptedEvents({
            organizationId: ORG,
            actionRequestId,
            authorizationEvidence: executed.value.authorizationEvidence,
            idempotencyKey: executed.value.idempotencyKey,
            executionRef: executed.value.executionRef,
            acceptedAt: now,
          }),
        });
      } else {
        await platform.repositories.results.save(
          {
            organizationId: ORG,
            actionRequestId,
            status: "executed",
            guaranteeLevel: executed.value.guaranteeLevel,
            idempotencyKey: executed.value.idempotencyKey,
            result: executed.value.result,
            completedAt: now,
          },
          actionExecutionOutcomeEvents({
            organizationId: ORG,
            actionRequestId,
            status: "executed",
            completedAt: now,
            authorizationEvidence: executed.value.authorizationEvidence,
            idempotencyKey: executed.value.idempotencyKey,
          }),
        );
      }
    }
    await settle();
  }

  /** 承認者が却下した（Approval Runtimeがrejectedで終端した）状態を記録する。 */
  async function reject(actionRequestId: ActionRequestId) {
    await platform.repositories.events.appendMany([
      actionEventRecord({
        organizationId: ORG,
        occurredAt: clock.now(),
        event: { type: "action.completed", actionRequestId, result: "rejected" },
      }),
    ]);
    await settle();
  }

  async function runOf(actionRequestId: ActionRequestId) {
    const run = await platform.repositories.runs.findByParentAction({
      organizationId: ORG,
      actionRequestId,
    });
    if (Result.isFailure(run) || !run.value)
      expect.fail(`run for ${String(actionRequestId)} not found`);
    return run.value;
  }

  async function runById(runId: WorkflowRunId) {
    const run = await platform.repositories.runs.load({ organizationId: ORG, runId });
    if (Result.isFailure(run) || !run.value) expect.fail(`run ${String(runId)} not found`);
    return run.value;
  }

  async function events(actionRequestId: ActionRequestId) {
    const listed = await platform.repositories.events.listForAction({
      organizationId: ORG,
      actionRequestId,
    });
    if (Result.isFailure(listed)) expect.fail(listed.error.message);
    return listed.value;
  }

  async function result(actionRequestId: ActionRequestId) {
    const loaded = await platform.repositories.results.load({
      organizationId: ORG,
      actionRequestId,
    });
    if (Result.isFailure(loaded)) expect.fail(loaded.error.message);
    return loaded.value;
  }

  /** child ActionRequest（相関記録済み）の一覧。 */
  async function children(runId: WorkflowRunId) {
    const listed = await platform.repositories.correlations.listForRun({
      organizationId: ORG,
      runId,
    });
    if (Result.isFailure(listed)) expect.fail(listed.error.message);
    return listed.value;
  }

  function fold(records: Awaited<ReturnType<typeof events>>, approvalRequired: boolean) {
    return foldActionRequestStatus(
      records.map((record) => record.event),
      { approvalRequired },
    );
  }

  return {
    db,
    faults,
    clock,
    executor,
    authorizer,
    approvals,
    platform,
    requireApproval,
    publish,
    submit,
    status,
    settle,
    approve,
    reject,
    loadPlan,
    runOf,
    runById,
    events,
    result,
    children,
    fold,
  };
}
