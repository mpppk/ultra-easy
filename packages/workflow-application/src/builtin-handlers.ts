import { Result } from "@praha/byethrow";

import type {
  EffectContext,
  EffectHandler,
  EffectHandlerError,
  EffectOutcomeReport,
} from "./ports.ts";

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

/**
 * Timer作用。sandbox / processを保持せず、予約時刻（requestedAt + seconds）の到来をpollで判定する。
 * 満了時刻は作用の予約内容から決定的に求まるため、再配送しても変わらない。
 */
export class TimerEffectHandler implements EffectHandler {
  private report(context: EffectContext): EffectOutcomeReport {
    const request = context.effect.request;
    if (request.kind !== "timer") {
      return { type: "failed", code: "effect_kind_mismatch", message: "timer作用ではありません" };
    }
    const due = addSeconds(context.effect.requestedAt, request.seconds);
    return Date.parse(context.now) >= Date.parse(due)
      ? { type: "completed", output: { firedAt: due } }
      : { type: "in_flight", waitingReason: "waiting_timer", wakeAt: due };
  }

  async dispatch(
    context: EffectContext,
  ): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    return Result.succeed(this.report(context));
  }

  async poll(context: EffectContext): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    return Result.succeed(this.report(context));
  }
}

/**
 * Human input作用。入力はtrusted API（`WorkflowRuntime.deliver`のeffect_completed）からだけ届く。
 * 待機中はNodeRunを`waiting_input`にする。
 */
export class HumanInputEffectHandler implements EffectHandler {
  async dispatch(): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    return Result.succeed({ type: "in_flight", waitingReason: "waiting_input" });
  }
}
