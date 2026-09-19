import { Result } from "@praha/byethrow";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowSleepDuration, WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import {
  advanceApprovalRuntime,
  ApproverResolverProviderError,
  expireApprovalRuntime,
  nextApprovalRuntimeExpiry,
  recordApprovalDecision,
  startApprovalRuntime,
} from "@app/approval-core";
import type {
  ActionExecutionGuaranteeLevel,
  ActionExecutionResult,
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalPlanChecksum,
  ApprovalRuntimeState,
  ApproverResolver,
  OrganizationId,
} from "@app/approval-core";
import {
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";
import { OpenFgaApproverResolver, OpenFgaClient } from "@app/approval-fga";

import {
  runActionExecution,
  type ActionExecutionTerminalStatus,
  type ActionExecutionWorkflowEnv,
} from "./action-execution.ts";

export type ActionWorkflowParams = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
};

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
      status: ApprovalRuntimeState["status"] | ActionExecutionTerminalStatus;
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
};

type RuntimeTransition =
  | { type: "advanced"; state: ApprovalRuntimeState }
  | { type: "failed"; code: string; message: string }
  | { type: "retry"; error: Error };
type RuntimeFailure = Extract<RuntimeTransition, { type: "failed" }>;
type RuntimeStepResult = Exclude<RuntimeTransition, { type: "retry" }>;

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
      type: "approval-decision",
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

function resolverFor(env: ActionWorkflowEnv, organizationId: OrganizationId): ApproverResolver {
  return new OpenFgaApproverResolver(
    new OpenFgaClient({
      apiUrl: env.OPENFGA_API_URL,
      storeId: env.OPENFGA_STORE_ID,
      authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
      organizationId,
      ...(env.OPENFGA_ASSUME_LIST_USERS_COMPLETE === "true"
        ? { listUsersCompleteness: "assume_complete" as const }
        : {}),
    }),
  );
}

async function persistProjection(
  env: ActionWorkflowEnv,
  organizationId: Parameters<D1ApprovalRuntimeProjectionRepository["replace"]>[0]["organizationId"],
  state: ApprovalRuntimeState,
): Promise<RuntimeTransition> {
  const stored = await new D1ApprovalRuntimeProjectionRepository(env.DB).replace({
    organizationId,
    state,
  });
  return Result.isFailure(stored) ? retry(stored.error) : { type: "advanced", state };
}

async function initializeRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  startedAt: string,
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
    resolver: resolverFor(env, params.organizationId),
    startedAt,
  });
  if (Result.isFailure(started)) return interpreterFailure(started.error);
  return persistProjection(env, loaded.plan.organizationId, started.value);
}

async function recordDecision(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  state: ApprovalRuntimeState,
  event: ApprovalDecisionEvent,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const recorded = await recordApprovalDecision({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId),
    state,
    event,
  });
  if (Result.isFailure(recorded)) return interpreterFailure(recorded.error);
  return persistProjection(env, loaded.plan.organizationId, recorded.value.state);
}

async function advanceRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  state: ApprovalRuntimeState,
  now: string,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const advanced = await advanceApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId),
    state,
    now,
  });
  if (Result.isFailure(advanced)) return interpreterFailure(advanced.error);
  return persistProjection(env, loaded.plan.organizationId, advanced.value);
}

async function expireRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  state: ApprovalRuntimeState,
  now: string,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const expired = await expireApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env, params.organizationId),
    state,
    now,
  });
  if (Result.isFailure(expired)) return interpreterFailure(expired.error);
  return persistProjection(env, loaded.plan.organizationId, expired.value);
}

async function runRuntimeStep(
  step: WorkflowStep,
  name: string,
  callback: () => Promise<RuntimeTransition>,
): Promise<RuntimeStepResult> {
  return step.do(name, async () => {
    const transition = await callback();
    if (transition.type === "retry") return Promise.reject(transition.error);
    return transition;
  });
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

function outputFromTransition(
  params: ActionWorkflowParams,
  transition: RuntimeFailure,
): ActionWorkflowOutput {
  return {
    type: "failed",
    actionRequestId: params.actionRequestId,
    code: transition.code,
    message: transition.message,
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

  const saved = await new D1ActionResultProjectionRepository(input.env.DB).save({
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
  });
  if (Result.isFailure(saved)) {
    return Result.fail(
      new ActionResultProjectionError(saved.error.message, { cause: saved.error }),
    );
  }
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

    let logicalNow = event.timestamp.toISOString();
    const initialized = await runRuntimeStep(step, "initialize approval runtime", () =>
      initializeRuntime(this.env, params, logicalNow),
    );
    if (initialized.type === "failed") return outputFromTransition(params, initialized);

    let state = initialized.state;
    let iteration = 0;
    while (state.status === "pending") {
      const nextExpiry = nextApprovalRuntimeExpiry(state);
      if (nextExpiry && Date.parse(nextExpiry) <= Date.parse(logicalNow)) {
        const expired = await runRuntimeStep(step, `expire approval runtime ${iteration}`, () =>
          expireRuntime(this.env, params, state, nextExpiry),
        );
        if (expired.type === "failed") return outputFromTransition(params, expired);
        state = expired.state;
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
      if (decision.type === "control_flow") return Promise.reject(decision.error);
      if (decision.type === "timeout") {
        if (nextExpiry) {
          const expired = await runRuntimeStep(step, `expire approval runtime ${iteration}`, () =>
            expireRuntime(this.env, params, state, nextExpiry),
          );
          if (expired.type === "failed") return outputFromTransition(params, expired);
          state = expired.state;
          logicalNow = nextExpiry;
        } else {
          logicalNow = addSeconds(logicalNow, timeout.seconds);
        }
        iteration += 1;
        continue;
      }

      const recorded = await runRuntimeStep(step, `record approval decision ${iteration}`, () =>
        recordDecision(this.env, params, state, decision.event),
      );
      if (recorded.type === "failed") return outputFromTransition(params, recorded);
      state = recorded.state;
      logicalNow = decision.event.decidedAt;

      const advanced = await runRuntimeStep(step, `activate approval runtime ${iteration}`, () =>
        advanceRuntime(this.env, params, state, logicalNow),
      );
      if (advanced.type === "failed") return outputFromTransition(params, advanced);
      state = advanced.state;
      iteration += 1;
    }

    if (state.status !== "approved" || this.env.ACTION_EXECUTION_MODE === "approval_only") {
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
    if (execution.type === "failed") {
      return {
        type: "failed",
        actionRequestId: params.actionRequestId,
        code: execution.code,
        message: execution.message,
      };
    }

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
      return {
        type: "failed",
        actionRequestId: params.actionRequestId,
        code: "execution_projection_failed",
        message: error instanceof Error ? error.message : String(error),
      };
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
