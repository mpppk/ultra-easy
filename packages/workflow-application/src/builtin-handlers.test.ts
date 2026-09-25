import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { EffectRecord, WorkflowNode } from "@app/workflow-core";

import { HumanInputEffectHandler, TimerEffectHandler } from "./builtin-handlers.ts";
import type { EffectContext } from "./ports.ts";

function context(effect: Partial<EffectRecord>, now: string): EffectContext {
  return {
    run: {} as EffectContext["run"],
    version: {} as EffectContext["version"],
    node: {} as WorkflowNode,
    effect: {
      id: "e" as EffectRecord["id"],
      nodeRunId: "n" as EffectRecord["nodeRunId"],
      request: { kind: "timer", seconds: 60 },
      status: "requested",
      requestedAt: "2026-09-25T00:00:00.000Z",
      ...effect,
    },
    now,
  };
}

describe("built-in effect handlers (#157)", () => {
  it("timer waits until requestedAt + seconds, deterministically", async () => {
    const handler = new TimerEffectHandler();
    expect(await handler.dispatch(context({}, "2026-09-25T00:00:30.000Z"))).toEqual(
      Result.succeed({
        type: "in_flight",
        waitingReason: "waiting_timer",
        wakeAt: "2026-09-25T00:01:00.000Z",
      }),
    );
    expect(await handler.poll(context({}, "2026-09-25T00:01:00.000Z"))).toEqual(
      Result.succeed({ type: "completed", output: { firedAt: "2026-09-25T00:01:00.000Z" } }),
    );
  });

  it("human input waits for trusted delivery", async () => {
    expect(await new HumanInputEffectHandler().dispatch()).toEqual(
      Result.succeed({ type: "in_flight", waitingReason: "waiting_input" }),
    );
  });
});
