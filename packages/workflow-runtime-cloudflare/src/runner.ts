import { Result } from "@praha/byethrow";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

import type { OrganizationId } from "@app/approval-core";
import type { WorkflowRuntime, WorkflowRunRepository } from "@app/workflow-application";
import { isTerminalWorkflowRunStatus } from "@app/workflow-core";
import type { WorkflowRunId, WorkflowRunStatus } from "@app/workflow-core";

export type WorkflowRunnerParams = {
  organizationId: OrganizationId;
  runId: WorkflowRunId;
};

/** child完了・human input等でrunnerを待機から起こすevent。 */
export const WORKFLOW_RESUME_EVENT_TYPE = "workflow-resume";

export type WorkflowRunnerOutput =
  | { type: "completed"; status: WorkflowRunStatus }
  | { type: "handoff"; status: WorkflowRunStatus }
  | { type: "failed"; code: string; message: string };

type AdvanceStepResult =
  | {
      type: "advanced";
      status: WorkflowRunStatus;
      revision: number;
      idleRounds: number;
      waitSeconds: number | null;
    }
  | { type: "failed"; code: string; message: string };

const ADVANCE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 10, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

/** Cloudflare Workflowsのstep上限を超えないよう、1 instanceで回すiteration数。超えたらsweeperへ引き継ぐ。 */
export const MAX_RUNNER_ITERATIONS = 400;
const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 60 * 60;

export async function workflowRunnerInstanceId(input: WorkflowRunnerParams): Promise<string> {
  const source = JSON.stringify([String(input.organizationId), String(input.runId)]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `wr_${hex}`;
}

function waitSeconds(wakeAt: string | undefined, now: number, idleRounds: number): number | null {
  if (wakeAt === undefined) return null;
  const until = Math.ceil((Date.parse(wakeAt) - now) / 1000);
  // 状態が変わらない待機ほど間隔を伸ばす（child完了はresume eventで即時に起こす）。
  const backoff = Math.min(MAX_WAIT_SECONDS, 2 ** Math.min(idleRounds, 12));
  return Math.max(MIN_WAIT_SECONDS, Math.min(MAX_WAIT_SECONDS, Math.max(until, backoff)));
}

function isTimeout(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.includes("WorkflowTimeoutError") || text.includes("timed out");
}

/**
 * 1つのWorkflowRunを進めるCloudflare Workflow本体。stateはD1にあり、各iterationは
 * `runtime.advance`（CAS保存）を1 stepとして実行する。待機中はprocess memoryを持たず、
 * `waitForEvent`（resume）かtimeoutで次のiterationへ進む。
 */
export async function runWorkflowRunner(input: {
  runtime: WorkflowRuntime;
  event: WorkflowEvent<WorkflowRunnerParams>;
  step: WorkflowStep;
}): Promise<WorkflowRunnerOutput> {
  const params = input.event.payload;
  if (input.event.instanceId !== (await workflowRunnerInstanceId(params))) {
    return {
      type: "failed",
      code: "workflow_runner_instance_id_mismatch",
      message: "runner instance idはorganizationId + runIdから導出する必要があります",
    };
  }
  let previousRevision = -1;
  let idleRounds = 0;
  let status: WorkflowRunStatus = "running";
  for (let iteration = 0; iteration < MAX_RUNNER_ITERATIONS; iteration += 1) {
    // step結果（cache）だけから導出し、replayでも同じ値になるようにする。
    const lastRevision = previousRevision;
    const lastIdle = idleRounds;
    const advanced = await input.step.do<AdvanceStepResult>(
      `advance ${iteration}`,
      ADVANCE_STEP_CONFIG,
      async () => {
        const result = await input.runtime.advance(params);
        if (Result.isFailure(result)) {
          if (result.error.retriable) return Promise.reject(result.error);
          return { type: "failed", code: result.error.code, message: result.error.message };
        }
        const idle = result.value.revision === lastRevision ? lastIdle + 1 : 0;
        return {
          type: "advanced",
          status: result.value.status,
          revision: result.value.revision,
          idleRounds: idle,
          waitSeconds: waitSeconds(result.value.wakeAt, Date.now(), idle),
        };
      },
    );
    if (advanced.type === "failed") return advanced;
    status = advanced.status;
    previousRevision = advanced.revision;
    idleRounds = advanced.idleRounds;
    if (advanced.waitSeconds === null) {
      return isTerminalWorkflowRunStatus(status)
        ? { type: "completed", status }
        : { type: "handoff", status };
    }
    try {
      await input.step.waitForEvent(`resume ${iteration}`, {
        type: WORKFLOW_RESUME_EVENT_TYPE,
        timeout: `${advanced.waitSeconds} seconds`,
      });
    } catch (error) {
      if (!isTimeout(error)) return Promise.reject(error);
    }
  }
  return { type: "handoff", status };
}

/** WorkflowRuntimeを依存注入してCloudflare Workflow classを組み立てる。 */
export function createWorkflowRunner<Env>(runtime: (env: Env) => WorkflowRuntime) {
  return class WorkflowRunner extends WorkflowEntrypoint<Env, WorkflowRunnerParams> {
    async run(
      event: WorkflowEvent<WorkflowRunnerParams>,
      step: WorkflowStep,
    ): Promise<WorkflowRunnerOutput> {
      return runWorkflowRunner({ runtime: runtime(this.env), event, step });
    }
  };
}

type WorkflowInstanceLike = {
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
};

export type WorkflowRunnerBinding = {
  create(options: { id: string; params: WorkflowRunnerParams }): Promise<unknown>;
  get(id: string): Promise<WorkflowInstanceLike>;
};

class WorkflowRunnerControlError extends Error {
  override readonly name = "WorkflowRunnerControlError";
}

const createInstance = Result.fn({
  try: async (input: {
    binding: WorkflowRunnerBinding;
    id: string;
    params: WorkflowRunnerParams;
  }) => input.binding.create({ id: input.id, params: input.params }),
  catch: (error): WorkflowRunnerControlError =>
    new WorkflowRunnerControlError(error instanceof Error ? error.message : String(error)),
});

const sendResume = Result.fn({
  try: async (input: { binding: WorkflowRunnerBinding; id: string }) => {
    const instance = await input.binding.get(input.id);
    await instance.sendEvent({ type: WORKFLOW_RESUME_EVENT_TYPE, payload: {} });
  },
  catch: (error): WorkflowRunnerControlError =>
    new WorkflowRunnerControlError(error instanceof Error ? error.message : String(error)),
});

/**
 * runner instanceの起動 / 再開。起動はinstance IDで冪等（既存instanceならresumeを送る）。
 * 失敗してもrunはD1に残り、cron sweeperが進めるためbest effortでよい。
 */
export class CloudflareWorkflowRunnerControl {
  constructor(private readonly binding: WorkflowRunnerBinding) {}

  async start(params: WorkflowRunnerParams): Promise<void> {
    const id = await workflowRunnerInstanceId(params);
    const created = await createInstance({ binding: this.binding, id, params });
    if (Result.isFailure(created)) await sendResume({ binding: this.binding, id });
  }

  async resume(params: WorkflowRunnerParams): Promise<void> {
    const id = await workflowRunnerInstanceId(params);
    await sendResume({ binding: this.binding, id });
  }
}

/**
 * cron sweeper。wakeAtが到来したrun（runnerがhandoffした / 起動に失敗した / 親への通知が
 * 未完了のrun）を直接進める。runnerと同時に進めてもCASで1つの遷移だけが確定する。
 */
export async function sweepDueWorkflowRuns(input: {
  runs: WorkflowRunRepository;
  runtime: WorkflowRuntime;
  now: string;
  limit?: number;
}): Result.ResultAsync<{ advanced: number; failed: number }, { code: string }> {
  const due = await input.runs.listDue({ now: input.now, limit: input.limit ?? 50 });
  if (Result.isFailure(due)) return Result.fail({ code: due.error.code });
  let failed = 0;
  for (const key of due.value) {
    const advanced = await input.runtime.advance(key);
    if (Result.isFailure(advanced)) failed += 1;
  }
  return Result.succeed({ advanced: due.value.length - failed, failed });
}
