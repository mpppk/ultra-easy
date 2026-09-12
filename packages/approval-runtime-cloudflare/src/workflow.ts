import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import {
  applyApprovalDecision,
  expireApprovalRuntime,
  nextApprovalRuntimeExpiry,
  startApprovalRuntime,
} from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalPlanChecksum,
  ApprovalRuntimeState,
  ApproverResolver,
} from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";
import { OpenFgaApproverResolver, OpenFgaClient } from "@app/approval-fga";

export type ActionWorkflowParams = {
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
};

export type ActionWorkflowOutput =
  | {
      type: "completed";
      actionRequestId: ActionRequestId;
      status: ApprovalRuntimeState["status"];
    }
  | {
      type: "failed";
      actionRequestId: ActionRequestId;
      code: string;
      message: string;
    };

export type ActionWorkflowEnv = {
  DB: D1Database;
  OPENFGA_API_URL: string;
  OPENFGA_STORE_ID: string;
  OPENFGA_AUTHORIZATION_MODEL_ID: string;
  OPENFGA_ASSUME_LIST_USERS_COMPLETE?: string;
};

type RuntimeTransition =
  | { type: "advanced"; state: ApprovalRuntimeState }
  | { type: "failed"; code: string; message: string };

export class WorkflowEventWaitError extends ErrorFactory({
  name: "WorkflowEventWaitError",
  message: ({ detail }) => `Approval Decision eventの待機に失敗しました: ${detail}`,
  fields: ErrorFactory.fields<{
    code: "workflow_event_wait_failed";
    detail: string;
  }>(),
}) {}

const waitForDecision = Result.fn({
  try: async (input: {
    step: WorkflowStep;
    name: string;
    timeout: string;
  }): Promise<ApprovalDecisionEvent> =>
    input.step.waitForEvent<ApprovalDecisionEvent>(input.name, {
      type: "approval-decision",
      timeout: input.timeout,
    }),
  catch: (error): WorkflowEventWaitError =>
    new WorkflowEventWaitError({
      code: "workflow_event_wait_failed",
      detail: error instanceof Error ? error.message : "waitForEvent failed",
      ...(error instanceof Error ? { cause: error } : {}),
    }),
});

function errorCode(error: Error): string {
  const value = (error as Error & { code?: unknown }).code;
  return typeof value === "string" ? value : error.name;
}

function failed(error: Error): RuntimeTransition {
  return { type: "failed", code: errorCode(error), message: error.message };
}

function loadFailure(result: Exclude<Awaited<ReturnType<D1MaterializedPlanRepository["loadForWorkflow"]>>, { type: "found" }>): RuntimeTransition {
  if (result.type === "not_found") {
    return { type: "failed", code: "approval_plan_not_found", message: "Materialized Approval Planが見つかりません" };
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

function resolverFor(env: ActionWorkflowEnv): ApproverResolver {
  return new OpenFgaApproverResolver(
    new OpenFgaClient({
      apiUrl: env.OPENFGA_API_URL,
      storeId: env.OPENFGA_STORE_ID,
      authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
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
  return Result.isFailure(stored) ? failed(stored.error) : { type: "advanced", state };
}

async function initializeRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  startedAt: string,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const started = await startApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env),
    startedAt,
  });
  if (Result.isFailure(started)) return failed(started.error);
  return persistProjection(env, loaded.plan.organizationId, started.value);
}

async function applyDecision(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  state: ApprovalRuntimeState,
  event: ApprovalDecisionEvent,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const decided = await applyApprovalDecision({
    plan: loaded.plan,
    resolver: resolverFor(env),
    state,
    event,
  });
  if (Result.isFailure(decided)) return failed(decided.error);
  return persistProjection(env, loaded.plan.organizationId, decided.value.state);
}

async function expireRuntime(
  env: ActionWorkflowEnv,
  params: ActionWorkflowParams,
  state: ApprovalRuntimeState,
  now: string,
): Promise<RuntimeTransition> {
  const repository = new D1MaterializedPlanRepository(env.DB);
  const loaded = await repository.loadForWorkflow({
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type !== "found") return loadFailure(loaded);

  const expired = await expireApprovalRuntime({
    plan: loaded.plan,
    resolver: resolverFor(env),
    state,
    now,
  });
  if (Result.isFailure(expired)) return failed(expired.error);
  return persistProjection(env, loaded.plan.organizationId, expired.value);
}

function isTimeout(error: WorkflowEventWaitError): boolean {
  return /tim(?:e|ed)[ -]?out/i.test(error.detail);
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function timeoutUntil(now: string, expiresAt?: string): { timeout: string; seconds: number } {
  if (!expiresAt) return { timeout: "365 days", seconds: 365 * 24 * 60 * 60 };
  const delta = Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / 1000);
  const seconds = Math.max(1, Math.min(365 * 24 * 60 * 60, delta));
  return { timeout: `${seconds} seconds`, seconds };
}

function outputFromTransition(
  params: ActionWorkflowParams,
  transition: Extract<RuntimeTransition, { type: "failed" }>,
): ActionWorkflowOutput {
  return {
    type: "failed",
    actionRequestId: params.actionRequestId,
    code: transition.code,
    message: transition.message,
  };
}

export class ActionWorkflow extends WorkflowEntrypoint<ActionWorkflowEnv, ActionWorkflowParams> {
  async run(
    event: WorkflowEvent<ActionWorkflowParams>,
    step: WorkflowStep,
  ): Promise<ActionWorkflowOutput> {
    const params = event.payload;
    let logicalNow = event.timestamp.toISOString();
    const initialized = await step.do("initialize approval runtime", async () =>
      initializeRuntime(this.env, params, logicalNow),
    );
    if (initialized.type === "failed") return outputFromTransition(params, initialized);

    let state = initialized.state;
    let iteration = 0;
    while (state.status === "pending") {
      const nextExpiry = nextApprovalRuntimeExpiry(state);
      if (nextExpiry && Date.parse(nextExpiry) <= Date.parse(logicalNow)) {
        const expired = await step.do(`expire approval runtime ${iteration}`, async () =>
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
      if (Result.isFailure(decision)) {
        if (!isTimeout(decision.error)) {
          return outputFromTransition(params, failed(decision.error));
        }
        if (nextExpiry) {
          const expired = await step.do(`expire approval runtime ${iteration}`, async () =>
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

      const advanced = await step.do(`apply approval decision ${iteration}`, async () =>
        applyDecision(this.env, params, state, decision.value),
      );
      if (advanced.type === "failed") return outputFromTransition(params, advanced);
      state = advanced.state;
      logicalNow = decision.value.decidedAt;
      iteration += 1;
    }

    return {
      type: "completed",
      actionRequestId: params.actionRequestId,
      status: state.status,
    };
  }
}
