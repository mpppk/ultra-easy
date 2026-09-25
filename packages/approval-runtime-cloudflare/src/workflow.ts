import { Result } from "@praha/byethrow";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowSleepDuration, WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import {
  actionEventRecord,
  actionExecutionOutcomeEvents,
  actionRuntimeTransitionEvents,
  advanceApprovalRuntime,
  ConsoleTelemetrySink,
  ApproverResolverProviderError,
  expireApprovalRuntime,
  isApprovalDecisionRejection,
  nextApprovalRuntimeExpiry,
  recordApprovalDecision,
  startApprovalRuntime,
} from "@app/approval-core";
import type {
  ActionExecutionGuaranteeLevel,
  ActionExecutionResult,
  ActionRequestStatus,
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalDecisionRejectionError,
  ApprovalPlanChecksum,
  ApprovalRuntimeState,
  ApproverResolver,
  MaterializedApprovalPlan,
  OrganizationId,
} from "@app/approval-core";
import {
  D1ActionEventRepository,
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
  D1PublicApiRepository,
} from "@app/approval-d1";
import {
  ClientCredentialsTokenProvider,
  OpenFgaApproverResolver,
  OpenFgaClient,
} from "@app/approval-fga";

import { runActionExecution, type ActionExecutionWorkflowEnv } from "./action-execution.ts";
import {
  emitActionSliSnapshot,
  emitDomainEventTelemetry,
  emitWorkflowFailure,
  emitWorkflowRetry,
} from "./telemetry.ts";

export type ActionWorkflowParams = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
};

export const APPROVAL_DECISION_EVENT_TYPE = "approval-decision";

/**
 * approval-decision eventを組み立てる。ApprovalDecisionEventへ型付けし、commentや
 * approvalBindingFingerprintなど任意fieldの取りこぼしを呼び出し側のcompile時に検出する。
 * decidedAtはWorkflowがevent timestampで確定し直す。
 */
export function approvalDecisionWorkflowEvent(event: ApprovalDecisionEvent): {
  type: typeof APPROVAL_DECISION_EVENT_TYPE;
  payload: ApprovalDecisionEvent;
} {
  return { type: APPROVAL_DECISION_EVENT_TYPE, payload: { ...event } };
}

export async function actionWorkflowInstanceId(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
}): Promise<string> {
  const source = JSON.stringify([String(input.organizationId), String(input.actionRequestId)]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `ue_${hex}`;
}

export type ActionWorkflowOutput =
  | {
      type: "completed";
      actionRequestId: ActionRequestId;
      /** ActionRequestの状態（coreの状態機械と同じ語彙、#101）。 */
      status: ActionRequestStatus;
      guaranteeLevel?: ActionExecutionGuaranteeLevel;
      idempotencyKey?: string;
      code?: string;
      message?: string;
    }
  | {
      type: "failed";
      actionRequestId: ActionRequestId;
      code: string;
      message: string;
    };

export type ActionWorkflowEnv = ActionExecutionWorkflowEnv & {
  DB: D1Database;
  ACTION_EXECUTION_MODE?: "execute" | "approval_only";
  OPENFGA_API_URL: string;
  OPENFGA_STORE_ID: string;
  OPENFGA_AUTHORIZATION_MODEL_ID: string;
  OPENFGA_ASSUME_LIST_USERS_COMPLETE?: string;
  OPENFGA_API_TOKEN?: string;
  FGA_CLIENT_ID?: string;
  FGA_CLIENT_SECRET?: string;
};

type RuntimeTransition =
  | {
      type: "advanced";
      state: ApprovalRuntimeState;
      /** projectionのversion（#89 CAS）。旧versionのstep結果から再開した場合は無い。 */
      version?: number;
      /** force-cancel等でWorkflow外から終端され、そのstateを採用した。 */
      superseded?: boolean;
    }
  | { type: "failed"; code: string; message: string }
  | { type: "retry"; error: Error };
type RuntimeFailure = Extract<RuntimeTransition, { type: "failed" }>;
/** Decision 1件の業務上の却下。stateは変わらず、Workflowは同じTaskの待機を継続する。 */
type DecisionRejected = { type: "decision_rejected"; code: string };
type DecisionTransition = RuntimeTransition | DecisionRejected;
type DecisionStepResult = Exclude<DecisionTransition, { type: "retry" }>;

type DecisionWaitResult =
  | { type: "decision"; event: ApprovalDecisionEvent }
  | { type: "timeout" }
  | { type: "control_flow"; error: unknown };

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const name = errorName(error);
  const message = errorMessage(error);
  if (name && message) return `${name}: ${message}`;
  return message ?? name;
}

export function isWorkflowTimeoutError(error: unknown): boolean {
  const name = errorName(error);
  const text = errorText(error);
  return (
    name === "WorkflowTimeoutError" ||
    text?.includes("WorkflowTimeoutError") === true ||
    text?.includes("Execution timed out after") === true
  );
}

async function waitForDecision(input: {
  step: WorkflowStep;
  name: string;
  timeout: WorkflowSleepDuration;
}): Promise<DecisionWaitResult> {
  try {
    const event = await input.step.waitForEvent<ApprovalDecisionEvent>(input.name, {
      type: APPROVAL_DECISION_EVENT_TYPE,
      timeout: input.timeout,
    });
    return {
      type: "decision",
      event: {
        ...event.payload,
        decidedAt: event.timestamp.toISOString(),
      },
    };
  } catch (error) {
    if (isWorkflowTimeoutError(error)) return { type: "timeout" };
    return { type: "control_flow", error };
  }
}

function errorCode(error: Error): string {
  const value = (error as Error & { code?: unknown }).code;
  return typeof value === "string" ? value : error.name;
}

function failed(error: Error): RuntimeFailure {
  return { type: "failed", code: errorCode(error), message: error.message };
}

function retry(error: Error): Extract<RuntimeTransition, { type: "retry" }> {
  return { type: "retry", error };
}

function interpreterFailure(
  error: Error,
): RuntimeFailure | Extract<RuntimeTransition, { type: "retry" }> {
  if (error instanceof ApproverResolverProviderError && error.retriable) return retry(error);
  return failed(error);
}

function loadFailure(
  result: Exclude<
    Awaited<ReturnType<D1MaterializedPlanRepository["loadForWorkflow"]>>,
    { type: "found" }
  >,
): RuntimeFailure | Extract<RuntimeTransition, { type: "retry" }> {
  if (result.type === "repository_error") {
    return retry(new Error(`Materialized Approval Plan repository error: ${result.message}`));
  }
  if (result.type === "not_found") {
    return {
      type: "failed",
      code: "approval_plan_not_found",
      message: "Materialized Approval Planが見つかりません",
    };
  }
  if (result.type === "checksum_mismatch") {
    return {
      type: "failed",
      code: "approval_plan_checksum_mismatch",
      message: `Workflow paramsのApproval Plan checksumと保存済みPlanが一致しません: ${String(result.actualApprovalPlanChecksum)}`,
    };
  }
  return {
    type: "failed",
    code: result.type,
    message: result.message,
  };
}

function resolverFor(
  env: ActionWorkflowEnv,
  organizationId: OrganizationId,
  actionRequestId: ActionRequestId,
): ApproverResolver {
  return new OpenFgaApproverResolver(
    new OpenFgaClient({
      apiUrl: env.OPENFGA_API_URL,
      storeId: env.OPENFGA_STORE_ID,
      authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
      organizationId,
      actionRequestId,
      ...(env.OPENFGA_API_TOKEN ? { token: env.OPENFGA_API_TOKEN } : {}),
      ...(env.FGA_CLIENT_ID && env.FGA_CLIENT_SECRET
        ? {
            tokenSupplier: new ClientCredentialsTokenProvider({
              tokenUrl: "https://auth.fga.dev/oauth/token",
              audience: "https://api.us1.fga.dev/",
              clientId: env.FGA_CLIENT_ID,
              clientSecret: env.FGA_CLIENT_SECRET,
            }),
          }
        : {}),
      telemetry: new ConsoleTelemetrySink(),
      ...(env.OPENFGA_ASSUME_LIST_USERS_COMPLETE === "true"
        ? { listUsersCompleteness: "assume_complete" as const }
        : {}),
    }),
  );
}

/**
 * runtime projectionをcompare-and-setで保存する（#89）。Workflowとforce-cancelの2つのwriterが
 * 競合しても状態を巻き戻さない。Workflow外から終端されていれば、そのstateを採用して終了する。
 */
async function persistProjection(input: {
  env: ActionWorkflowEnv;
  plan: MaterializedApprovalPlan;
  previousState: ApprovalRuntimeState | null;
  state: ApprovalRuntimeState;
  workflowInstanceId?: string;
  /** null = 新規作成。undefined = versionを持たない旧step結果からの再開（現在値を読む）。 */
  expectedVersion: number | null | undefined;
  writer: string;
}): Promise<RuntimeTransition> {
  const repository = new D1ApprovalRuntimeProjectionRepository(input.env.DB);
  let expectedVersion = input.expectedVersion;
  if (expectedVersion === undefined) {
    const current = await repository.loadVersioned({
      organizationId: input.plan.organizationId,
      actionRequestId: input.plan.actionRequestId,
    });
    if (Result.isFailure(current)) return retry(current.error);
    expectedVersion = current.value?.version ?? null;
  }
  const events = actionRuntimeTransitionEvents({
    plan: input.plan,
    previousState: input.previousState,
    nextState: input.state,
    ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
  });
  const stored = await repository.compareAndReplace({
    organizationId: input.plan.organizationId,
    state: input.state,
    events,
    expectedVersion,
    writer: input.writer,
  });
  if (Result.isFailure(stored)) return retry(stored.error);
  if (stored.value.type === "conflict") {
    const current = stored.value.current;
    if (current && current.state.status !== "pending") {
      return { type: "advanced", state: current.state, version: current.version, superseded: true };
    }
    return {
      type: "failed",
      code: "approval_runtime_projection_conflict",
      message: "runtime projectionが別のwriterによって更新されました",
    };
  }
  emitDomainEventTelemetry(new ConsoleTelemetrySink(), events);
  return { type: "advanced", state: stored.value.state, version: stored.value.version };
}

async function initializeRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  startedAt: string,
  workflowInstanceId: string,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const started = await startApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId, params.actionRequestId),
    startedAt,
  });
  if (Result.isFailure(started)) return interpreterFailure(started.error);
  return persistProjection({
    env,
    plan: loaded.plan,
    previousState: null,
    state: started.value,
    workflowInstanceId,
    expectedVersion: null,
    writer: "initialize approval runtime",
  });
}

function retryOnCommandFailure(error: Error): Extract<RuntimeTransition, { type: "retry" }> {
  return retry(new Error(`Approval command outcomeを保存できません: ${error.message}`));
}

/**
 * 却下されたDecisionを監査イベントとcommand（rejected）へ記録する。runtime stateは変更しない。
 * eventKeyとcommandのCASにより、step retryで再実行しても重複しない。
 */
async function rejectDecision(
  env: ActionWorkflowEnv,
  plan: MaterializedApprovalPlan,
  event: ApprovalDecisionEvent,
  error: ApprovalDecisionRejectionError,
): Promise<DecisionTransition> {
  const record = actionEventRecord({
    organizationId: plan.organizationId,
    occurredAt: event.decidedAt,
    event: {
      type: "approval_decision.rejected",
      actionRequestId: plan.actionRequestId,
      taskId: event.taskId,
      decisionKey: event.idempotencyKey,
      actorId: event.userId,
      decision: event.decision,
      code: error.code,
    },
  });
  const appended = await new D1ActionEventRepository(env.DB).append(record);
  if (Result.isFailure(appended)) return retry(appended.error);

  const resolved = await new D1PublicApiRepository(env.DB).resolveOutcome({
    organizationId: plan.organizationId,
    commandId: event.idempotencyKey,
    status: "rejected",
    resolvedAt: event.decidedAt,
    error: {
      type: `urn:ultra-easy:problem:${error.code}`,
      title: "Decisionは受理されませんでした",
      status: 422,
      code: error.code,
      detail: error.message,
    },
  });
  if (Result.isFailure(resolved)) return retryOnCommandFailure(resolved.error);
  emitDomainEventTelemetry(new ConsoleTelemetrySink(), [record]);
  return { type: "decision_rejected", code: error.code };
}

type RuntimeCursor = { state: ApprovalRuntimeState; version: number | undefined; writer: string };

async function recordDecision(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  cursor: RuntimeCursor,
  event: ApprovalDecisionEvent,
): Promise<DecisionTransition> {
  const { state } = cursor;
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const recorded = await recordApprovalDecision({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId, params.actionRequestId),
    state,
    event,
  });
  if (Result.isFailure(recorded)) {
    return isApprovalDecisionRejection(recorded.error)
      ? rejectDecision(env, loaded.plan, event, recorded.error)
      : interpreterFailure(recorded.error);
  }
  const persisted = await persistProjection({
    env,
    plan: loaded.plan,
    previousState: state,
    state: recorded.value.state,
    expectedVersion: cursor.version,
    writer: cursor.writer,
  });
  if (persisted.type !== "advanced") return persisted;

  // commandの「applied」はWorkflowがDecisionを受理した時点で確定する（配送済みとは区別する）。
  // Workflow外で終端されていた（force-cancel）場合、Decisionは適用されていない。
  const resolved = await new D1PublicApiRepository(env.DB).resolveOutcome({
    organizationId: loaded.plan.organizationId,
    commandId: event.idempotencyKey,
    status: persisted.superseded ? "rejected" : "applied",
    resolvedAt: event.decidedAt,
    ...(persisted.superseded
      ? {
          error: {
            type: "urn:ultra-easy:problem:action_request_not_pending",
            title: "Decisionは受理されませんでした",
            status: 409,
            code: "action_request_not_pending",
            detail: `ActionRequestは既に${persisted.state.status}です`,
          },
        }
      : {}),
  });
  if (Result.isFailure(resolved)) return retryOnCommandFailure(resolved.error);
  return persisted;
}

async function advanceRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  cursor: RuntimeCursor,
  now: string,
): Promise<RuntimeTransition> {
  const { state } = cursor;
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const advanced = await advanceApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId, params.actionRequestId),
    state,
    now,
  });
  if (Result.isFailure(advanced)) return interpreterFailure(advanced.error);
  return persistProjection({
    env,
    plan: loaded.plan,
    previousState: state,
    state: advanced.value,
    expectedVersion: cursor.version,
    writer: cursor.writer,
  });
}

async function expireRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  cursor: RuntimeCursor,
  now: string,
): Promise<RuntimeTransition> {
  const { state } = cursor;
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const expired = await expireApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId, params.actionRequestId),
    state,
    now,
  });
  if (Result.isFailure(expired)) return interpreterFailure(expired.error);
  return persistProjection({
    env,
    plan: loaded.plan,
    previousState: state,
    state: expired.value,
    expectedVersion: cursor.version,
    writer: cursor.writer,
  });
}

async function runRuntimeStep<T extends DecisionTransition>(
  step: WorkflowStep,
  name: string,
  params: ActionWorkflowParams,
  callback: () => Promise<T>,
): Promise<Exclude<T, { type: "retry" }>> {
  const result = await step.do(name, async (): Promise<DecisionStepResult> => {
    const transition = await callback();
    if (transition.type === "retry") {
      emitWorkflowRetry({
        telemetry: new ConsoleTelemetrySink(),
        organizationId: params.organizationId,
        actionRequestId: params.actionRequestId,
        operation: name,
        errorCode: errorCode(transition.error),
      });
      return Promise.reject(transition.error);
    }
    return transition;
  });
  return result as Exclude<T, { type: "retry" }>;
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function timeoutUntil(
  now: string,
  expiresAt?: string,
): { timeout: WorkflowSleepDuration; seconds: number } {
  if (!expiresAt) return { timeout: "365 days", seconds: 365 * 24 * 60 * 60 };
  const delta = Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / 1000);
  const seconds = Math.max(1, Math.min(365 * 24 * 60 * 60, delta));
  return { timeout: `${seconds} seconds`, seconds };
}

class ActionResultProjectionError extends Error {
  readonly name = "ActionResultProjectionError";
}

const parseActionExecutionResult = Result.fn({
  try: (value: string): ActionExecutionResult => JSON.parse(value) as ActionExecutionResult,
  catch: (error): ActionResultProjectionError =>
    new ActionResultProjectionError(
      error instanceof Error ? error.message : "Action execution resultをparseできません",
    ),
});

/**
 * Workflowの異常終了を記録して`failed`出力を返す（#101 / #109）。telemetryに加えて
 * `workflow.failed` domain eventをaction_eventsへ残し、ActionRequestの状態を`failed`にする
 * （pending_approvalのまま放置しない）。eventの保存自体に失敗しても終了は妨げない。
 */
async function failWorkflow(input: {
  env: ActionWorkflowEnv;
  step: WorkflowStep;
  params: ActionWorkflowParams;
  workflowInstanceId: string;
  operation: string;
  code: string;
  message: string;
}): Promise<ActionWorkflowOutput> {
  emitWorkflowFailure({
    telemetry: new ConsoleTelemetrySink(),
    organizationId: input.params.organizationId,
    actionRequestId: input.params.actionRequestId,
    operation: input.operation,
    errorCode: input.code,
  });
  const record = actionEventRecord({
    organizationId: input.params.organizationId,
    occurredAt: new Date().toISOString(),
    event: {
      type: "workflow.failed",
      actionRequestId: input.params.actionRequestId,
      workflowInstanceId: input.workflowInstanceId,
      code: input.code,
    },
  });
  try {
    await input.step.do("record workflow failure", async () => {
      // occurredAtはstep結果として固定し、replayで別の時刻のeventを作らない。
      const appended = await new D1ActionEventRepository(input.env.DB).appendMany([record]);
      if (Result.isFailure(appended)) return Promise.reject(appended.error);
      return { recordedAt: record.occurredAt };
    });
  } catch {
    // 記録できなくてもWorkflowは終了させる（telemetryのworkflow.failure_totalは出ている）。
  }
  return {
    type: "failed",
    actionRequestId: input.params.actionRequestId,
    code: input.code,
    message: input.message,
  };
}

async function projectActionResult(input: {
  env: ActionWorkflowEnv;
  params: ActionWorkflowParams;
  workflowInstanceId: string;
  execution: Extract<Awaited<ReturnType<typeof runActionExecution>>, { type: "completed" }>;
  completedAt: string;
}): Result.ResultAsync<void, ActionResultProjectionError> {
  const loaded = await new D1MaterializedPlanRepository(input.env.DB).loadForWorkflow({
    organizationId: input.params.organizationId,
    actionRequestId: input.params.actionRequestId,
    expectedApprovalPlanChecksum: input.params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") {
    return Result.fail(
      new ActionResultProjectionError(
        `Action result projection用Planを取得できませんでした: ${loaded.type}`,
      ),
    );
  }

  let result: ActionExecutionResult | undefined;
  if (input.execution.resultJson !== undefined) {
    const parsed = parseActionExecutionResult(input.execution.resultJson);
    if (Result.isFailure(parsed)) return parsed;
    result = parsed.value;
  }

  const events = actionExecutionOutcomeEvents({
    organizationId: loaded.plan.organizationId,
    actionRequestId: loaded.plan.actionRequestId,
    status: input.execution.status,
    completedAt: input.completedAt,
    ...(input.execution.authorizationEvidence
      ? { authorizationEvidence: input.execution.authorizationEvidence }
      : {}),
    ...(input.execution.idempotencyKey ? { idempotencyKey: input.execution.idempotencyKey } : {}),
    ...(input.execution.retriable !== undefined ? { retriable: input.execution.retriable } : {}),
    ...(input.execution.code !== undefined ? { code: input.execution.code } : {}),
    ...(input.execution.message !== undefined ? { message: input.execution.message } : {}),
  });

  const saved = await new D1ActionResultProjectionRepository(input.env.DB).save(
    {
      organizationId: loaded.plan.organizationId,
      actionRequestId: loaded.plan.actionRequestId,
      workflowInstanceId: input.workflowInstanceId,
      status: input.execution.status,
      ...(input.execution.guaranteeLevel !== undefined
        ? { guaranteeLevel: input.execution.guaranteeLevel }
        : {}),
      ...(input.execution.idempotencyKey !== undefined
        ? { idempotencyKey: input.execution.idempotencyKey }
        : {}),
      ...(result !== undefined ? { result } : {}),
      ...(input.execution.code !== undefined ? { code: input.execution.code } : {}),
      ...(input.execution.message !== undefined ? { message: input.execution.message } : {}),
      completedAt: input.completedAt,
    },
    events,
  );
  if (Result.isFailure(saved)) {
    return Result.fail(
      new ActionResultProjectionError(saved.error.message, { cause: saved.error }),
    );
  }
  const telemetry = new ConsoleTelemetrySink();
  emitDomainEventTelemetry(telemetry, events);
  await emitActionSliSnapshot({
    db: input.env.DB,
    organizationId: loaded.plan.organizationId,
    actionRequestId: loaded.plan.actionRequestId,
    telemetry,
  });
  return Result.succeed(undefined);
}

export class ActionWorkflow extends WorkflowEntrypoint<ActionWorkflowEnv, ActionWorkflowParams> {
  async run(
    event: WorkflowEvent<ActionWorkflowParams>,
    step: WorkflowStep,
  ): Promise<ActionWorkflowOutput> {
    const params = event.payload;

    if (event.instanceId !== (await actionWorkflowInstanceId(params))) {
      return {
        type: "failed",
        actionRequestId: params.actionRequestId,
        code: "workflow_instance_id_mismatch",
        message: `Workflow instance idはorganizationId + actionRequestIdと一致する必要があります: ${event.instanceId}`,
      };
    }

    const fail = (operation: string, failure: { code: string; message: string }) =>
      failWorkflow({
        env: this.env,
        step,
        params,
        workflowInstanceId: event.instanceId,
        operation,
        code: failure.code,
        message: failure.message,
      });

    let logicalNow = event.timestamp.toISOString();
    const initialized = await runRuntimeStep(step, "initialize approval runtime", params, () =>
      initializeRuntime(this.env, params, logicalNow, event.instanceId),
    );
    if (initialized.type === "failed") return fail("approval_runtime", initialized);

    let state = initialized.state;
    let version = initialized.version;
    const cursor = (writer: string): RuntimeCursor => ({ state, version, writer });
    let iteration = 0;
    while (state.status === "pending") {
      const nextExpiry = nextApprovalRuntimeExpiry(state);
      if (nextExpiry && Date.parse(nextExpiry) <= Date.parse(logicalNow)) {
        const name = `expire approval runtime ${iteration}`;
        const expired = await runRuntimeStep(step, name, params, () =>
          expireRuntime(this.env, params, cursor(name), nextExpiry),
        );
        if (expired.type === "failed") return fail("approval_runtime", expired);
        state = expired.state;
        version = expired.version;
        logicalNow = nextExpiry;
        iteration += 1;
        continue;
      }

      const timeout = timeoutUntil(logicalNow, nextExpiry);
      const decision = await waitForDecision({
        step,
        name: `wait for approval decision ${iteration}`,
        timeout: timeout.timeout,
      });
      if (decision.type === "control_flow") {
        emitWorkflowFailure({
          telemetry: new ConsoleTelemetrySink(),
          organizationId: params.organizationId,
          actionRequestId: params.actionRequestId,
          operation: "wait_for_approval_decision",
          errorCode: errorName(decision.error) ?? "workflow_control_flow_error",
        });
        return Promise.reject(decision.error);
      }
      if (decision.type === "timeout") {
        if (nextExpiry) {
          const name = `expire approval runtime ${iteration}`;
          const expired = await runRuntimeStep(step, name, params, () =>
            expireRuntime(this.env, params, cursor(name), nextExpiry),
          );
          if (expired.type === "failed") return fail("approval_runtime", expired);
          state = expired.state;
          version = expired.version;
          logicalNow = nextExpiry;
        } else {
          logicalNow = addSeconds(logicalNow, timeout.seconds);
        }
        iteration += 1;
        continue;
      }

      const recordName = `record approval decision ${iteration}`;
      const recorded = await runRuntimeStep(step, recordName, params, () =>
        recordDecision(this.env, params, cursor(recordName), decision.event),
      );
      if (recorded.type === "failed") return fail("approval_runtime", recorded);
      if (recorded.type === "decision_rejected") {
        // invalid decisionは監査に残して無視し、同じTaskの待機を継続する。
        if (Date.parse(decision.event.decidedAt) > Date.parse(logicalNow)) {
          logicalNow = decision.event.decidedAt;
        }
        iteration += 1;
        continue;
      }
      state = recorded.state;
      version = recorded.version;
      logicalNow = decision.event.decidedAt;
      if (state.status !== "pending" && recorded.superseded) break;

      const activateName = `activate approval runtime ${iteration}`;
      const advanced = await runRuntimeStep(step, activateName, params, () =>
        advanceRuntime(this.env, params, cursor(activateName), logicalNow),
      );
      if (advanced.type === "failed") return fail("approval_runtime", advanced);
      state = advanced.state;
      version = advanced.version;
      iteration += 1;
    }

    if (state.status !== "approved" || this.env.ACTION_EXECUTION_MODE === "approval_only") {
      if (state.status !== "approved") {
        await emitActionSliSnapshot({
          db: this.env.DB,
          organizationId: params.organizationId,
          actionRequestId: params.actionRequestId,
          telemetry: new ConsoleTelemetrySink(),
        });
      }
      return {
        type: "completed",
        actionRequestId: params.actionRequestId,
        status: state.status,
      };
    }

    const execution = await runActionExecution({
      env: this.env,
      params,
      step,
      evaluatedAt: logicalNow,
    });
    if (execution.type === "failed") return fail("action_execution", execution);

    try {
      await step.do("project action result", async () => {
        const projected = await projectActionResult({
          env: this.env,
          params,
          workflowInstanceId: event.instanceId,
          execution,
          completedAt: logicalNow,
        });
        if (Result.isFailure(projected)) return Promise.reject(projected.error);
        return { type: "projected" } as const;
      });
    } catch (error) {
      return fail("project_action_result", {
        code: "execution_projection_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      type: "completed",
      actionRequestId: params.actionRequestId,
      status: execution.status,
      ...(execution.guaranteeLevel !== undefined
        ? { guaranteeLevel: execution.guaranteeLevel }
        : {}),
      ...(execution.idempotencyKey !== undefined
        ? { idempotencyKey: execution.idempotencyKey }
        : {}),
      ...(execution.code ? { code: execution.code } : {}),
      ...(execution.message ? { message: execution.message } : {}),
    };
  }
}
