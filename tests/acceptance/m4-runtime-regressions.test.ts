import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  ApprovalCandidateRejectedError,
  ApproverResolverProviderError,
  InvalidRuntimeTimestampError,
  UnsupportedInterpreterSemanticsVersionError,
} from "@app/approval-core";

import {
  alice,
  bob,
  decision,
  directStep,
  MutableResolver,
  plan,
  relationStep,
  runtime,
  startedAt,
  taskId,
} from "./m4-fixtures.ts";

class FlakyResolver extends MutableResolver {
  failNextList = false;

  override list(
    input: Parameters<MutableResolver["list"]>[0],
  ): ReturnType<MutableResolver["list"]> {
    if (this.failNextList) {
      this.failNextList = false;
      return Promise.resolve(
        Result.fail(
          new ApproverResolverProviderError({
            provider: "test",
            code: "transient",
            retriable: true,
            detail: "temporary resolver failure",
          }),
        ),
      );
    }
    return super.list(input);
  }
}

describe("M4 Durable Approval Runtime / regressions", () => {
  it("不正なdecidedAtを受理せずruntime stateを変更しない", async () => {
    const { runtime: memory } = runtime();
    const p = plan(directStep("timestamp", alice), "invalid-timestamp");
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));

    const invalid = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "invalid-time", "yesterday"),
    });
    assert(Result.isFailure(invalid));
    expect(invalid.error).toBeInstanceOf(InvalidRuntimeTimestampError);

    const loaded = await memory.load(p.actionRequestId);
    assert(Result.isSuccess(loaded));
    expect(loaded.value?.processedDecisionKeys).toEqual([]);
    expect(loaded.value?.tasks[0]?.decisions).toEqual([]);
  });

  it("allow-listに含まれていても実装のないinterpreter semantics versionは実行しない", async () => {
    const { runtime: memory } = runtime(new MutableResolver(), [1, 2]);
    const v2 = plan(directStep("future", alice), "unimplemented-v2", 2);
    const started = await memory.start({ plan: v2, startedAt });
    assert(Result.isFailure(started));
    expect(started.error).toBeInstanceOf(UnsupportedInterpreterSemanticsVersionError);
  });

  it("activationの一時失敗でも受理済みDecisionを保持し、同一event再送で続行する", async () => {
    const resolver = new FlakyResolver();
    const { runtime: memory } = runtime(resolver);
    const first = directStep("first", alice);
    const second = relationStep("second", "manager", { resolution: "dynamic" });
    resolver.set(second.target, [bob]);
    const p = plan({ type: "serial", children: [first, second] }, "activation-retry");
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));

    const event = decision(taskId(started.value), alice, "approve", "stable-decision");
    resolver.failNextList = true;
    const failed = await memory.decide({ actionRequestId: p.actionRequestId, event });
    assert(Result.isFailure(failed));
    expect(failed.error).toBeInstanceOf(ApproverResolverProviderError);

    const afterFailure = await memory.load(p.actionRequestId);
    assert(Result.isSuccess(afterFailure));
    expect(afterFailure.value?.processedDecisionKeys).toEqual(["stable-decision"]);
    expect(afterFailure.value?.tasks[0]?.status).toBe("approved");
    expect(afterFailure.value?.tasks[0]?.decisions).toHaveLength(1);

    const retried = await memory.decide({ actionRequestId: p.actionRequestId, event });
    assert(Result.isSuccess(retried));
    expect(retried.value.duplicate).toBe(true);
    expect(retried.value.state.tasks).toHaveLength(2);
    expect(retried.value.state.tasks[1]?.candidateUserIds.map(String)).toEqual(["user:bob"]);
  });

  it("parallel distinctApproversで重複候補しか残らないtaskをpendingのまま残さない", async () => {
    const { runtime: memory } = runtime();
    const first = directStep("parallel-first", alice);
    const second = directStep("parallel-second", alice);
    const p = plan(
      {
        type: "parallel",
        strategy: "all",
        constraints: { distinctApprovers: true },
        children: [first, second],
      },
      "parallel-distinct-deadlock",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    expect(started.value.tasks).toHaveLength(2);

    const decided = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "parallel-first-approved"),
    });
    assert(Result.isSuccess(decided));
    expect(decided.value.state.status).toBe("rejected");
    expect(decided.value.state.tasks[0]?.status).toBe("approved");
    expect(decided.value.state.tasks[1]?.status).toBe("rejected");
  });

  it("resolution省略時はdynamicとしてDecision時に再Checkする", async () => {
    const { runtime: memory, resolver } = runtime();
    const step = relationStep("default-dynamic", "manager", { resolution: undefined });
    resolver.set(step.target, [alice]);
    const p = plan(step, "default-dynamic");
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));

    resolver.set(step.target, [bob]);
    const stale = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "stale-candidate"),
    });
    assert(Result.isFailure(stale));
    expect(stale.error).toBeInstanceOf(ApprovalCandidateRejectedError);

    const current = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), bob, "approve", "current-candidate"),
    });
    assert(Result.isSuccess(current));
    expect(current.value.state.status).toBe("approved");
  });
});
