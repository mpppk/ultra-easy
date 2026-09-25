import { Result } from "@praha/byethrow";

import {
  HumanInputEffectHandler,
  TimerEffectHandler,
  WorkflowRuntime,
} from "@app/workflow-application";
import type { EffectHandler, EffectOutcomeReport } from "@app/workflow-application";
import { D1WorkflowRunRepository, D1WorkflowVersionRepository } from "@app/workflow-d1";
import type { D1DatabaseLike } from "@app/workflow-d1";

import { createWorkflowRunner } from "../runner.ts";

type TestEnv = { DB: D1DatabaseLike };

/** child ActionRequestを即時に完了させるtest用action handler（effect IDで冪等）。 */
const immediateAction: EffectHandler = {
  async dispatch(context) {
    return Result.succeed<EffectOutcomeReport>({
      type: "completed",
      output: { done: String(context.effect.id) },
      reference: `child:${String(context.effect.id)}`,
    });
  },
};

/** 最初の実行でhuman inputをyieldし、resume時に入力値をoutputにするtest program。 */
const scriptedProgram: EffectHandler = {
  async dispatch(context) {
    const request = context.effect.request;
    if (request.kind !== "program") {
      return Result.succeed<EffectOutcomeReport>({ type: "failed", code: "x", message: "x" });
    }
    if (!request.resume) {
      return Result.succeed<EffectOutcomeReport>({
        type: "yielded",
        state: { asked: true },
        effect: { type: "human_input", prompt: "値を入力してください" },
      });
    }
    const result = request.resume.effectResult;
    return Result.succeed<EffectOutcomeReport>({
      type: "completed",
      output: { input: result.type === "completed" ? result.output : null },
    });
  },
};

export function testWorkflowRuntime(env: TestEnv): WorkflowRuntime {
  return new WorkflowRuntime({
    versions: new D1WorkflowVersionRepository(env.DB),
    runs: new D1WorkflowRunRepository(env.DB),
    clock: { now: () => new Date().toISOString() },
    effects: {
      action: immediateAction,
      program: scriptedProgram,
      human_input: new HumanInputEffectHandler(),
      timer: new TimerEffectHandler(),
    },
    pollIntervalSeconds: 1,
  });
}

export const TestWorkflowRunner = createWorkflowRunner<TestEnv>(testWorkflowRuntime);

export default {
  async fetch(): Promise<Response> {
    return new Response("workflow runtime test worker");
  },
};
