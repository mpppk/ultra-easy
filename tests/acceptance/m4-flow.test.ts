import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  alice,
  bob,
  carol,
  decision,
  directStep,
  plan,
  runtime,
  startedAt,
  taskId,
} from "./m4-fixtures.ts";

describe("M4 Durable Approval Runtime / Flow semantics", () => {
  it("AC-M4-001: serialは前Step完了前に後続をactivateしない", async () => {
    const { runtime: memory } = runtime();
    const p = plan(
      { type: "serial", children: [directStep("manager", alice), directStep("finance", bob)] },
      "serial-activate",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    expect(started.value.tasks.map((task) => String(task.materializedStepId))).toEqual([
      "mstep:manager",
    ]);

    const approved = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "d1"),
    });
    assert(Result.isSuccess(approved));
    expect(approved.value.state.tasks.map((task) => String(task.materializedStepId))).toEqual([
      "mstep:manager",
      "mstep:finance",
    ]);
  });

  it("AC-M4-002: serial rejectでは後続taskを生成しない", async () => {
    const { runtime: memory } = runtime();
    const p = plan(
      { type: "serial", children: [directStep("manager", alice), directStep("finance", bob)] },
      "serial-reject",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    const rejected = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "reject", "d1"),
    });
    assert(Result.isSuccess(rejected));
    expect(rejected.value.state.status).toBe("rejected");
    expect(rejected.value.state.tasks).toHaveLength(1);
  });

  it("AC-M4-003: parallel/allは1 rejectで即rejectする", async () => {
    const { runtime: memory } = runtime();
    const p = plan(
      {
        type: "parallel",
        strategy: "all",
        children: [directStep("a", alice), directStep("b", bob)],
      },
      "parallel-all",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    expect(started.value.tasks).toHaveLength(2);
    const rejected = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "reject", "d1"),
    });
    assert(Result.isSuccess(rejected));
    expect(rejected.value.state.status).toBe("rejected");
    expect(rejected.value.state.tasks[1]?.status).toBe("cancelled");
  });

  it("AC-M4-004: parallel/anyは1 approveでapproveし、全rejectでrejectする", async () => {
    const first = runtime().runtime;
    const approvedPlan = plan(
      {
        type: "parallel",
        strategy: "any",
        children: [directStep("a", alice), directStep("b", bob)],
      },
      "parallel-any-approve",
    );
    const started = await first.start({ plan: approvedPlan, startedAt });
    assert(Result.isSuccess(started));
    const approved = await first.decide({
      actionRequestId: approvedPlan.actionRequestId,
      event: decision(taskId(started.value, 1), bob, "approve", "approve-b"),
    });
    assert(Result.isSuccess(approved));
    expect(approved.value.state.status).toBe("approved");

    const second = runtime().runtime;
    const rejectedPlan = plan(
      {
        type: "parallel",
        strategy: "any",
        children: [directStep("c", alice), directStep("d", bob)],
      },
      "parallel-any-reject",
    );
    const rejectedStarted = await second.start({ plan: rejectedPlan, startedAt });
    assert(Result.isSuccess(rejectedStarted));
    const r1 = await second.decide({
      actionRequestId: rejectedPlan.actionRequestId,
      event: decision(taskId(rejectedStarted.value, 0), alice, "reject", "reject-a"),
    });
    assert(Result.isSuccess(r1));
    expect(r1.value.state.status).toBe("pending");
    const r2 = await second.decide({
      actionRequestId: rejectedPlan.actionRequestId,
      event: decision(
        taskId(r1.value.state, 1),
        bob,
        "reject",
        "reject-b",
        "2026-09-13T00:02:00.000Z",
      ),
    });
    assert(Result.isSuccess(r2));
    expect(r2.value.state.status).toBe("rejected");
  });

  it("AC-M4-005: quorum到達不能を残りDecision前に判定する", async () => {
    const { runtime: memory } = runtime();
    const p = plan(
      {
        type: "parallel",
        strategy: "quorum",
        quorum: 2,
        children: [directStep("a", alice), directStep("b", bob), directStep("c", carol)],
      },
      "quorum",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    const r1 = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value, 0), alice, "reject", "r-a"),
    });
    assert(Result.isSuccess(r1));
    const r2 = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(r1.value.state, 1), bob, "reject", "r-b"),
    });
    assert(Result.isSuccess(r2));
    expect(r2.value.state.status).toBe("rejected");
    expect(r2.value.state.tasks[2]?.status).toBe("cancelled");
  });
});
