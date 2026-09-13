import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  ApprovalCandidateRejectedError,
  ApprovalDistinctApproverViolationError,
  ApprovalSelfApprovalDeniedError,
  ApprovalTaskClosedError,
  ApprovalUserAlreadyDecidedError,
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

describe("M4 Durable Approval Runtime / safety", () => {
  it("AC-M4-006: distinctApproversをFlow全体で守る", async () => {
    const { runtime: memory, resolver } = runtime();
    const firstStep = relationStep("manager", "manager");
    const secondStep = relationStep("finance", "finance", { resolution: "dynamic" });
    resolver.set(firstStep.target, [alice, bob]);
    resolver.set(secondStep.target, [alice, bob]);
    const p = plan(
      {
        type: "serial",
        constraints: { distinctApprovers: true },
        children: [firstStep, secondStep],
      },
      "distinct",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    const firstApproved = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "first"),
    });
    assert(Result.isSuccess(firstApproved));
    expect(firstApproved.value.state.tasks[1]?.candidateUserIds.map(String)).toEqual(["user:bob"]);

    const duplicateUser = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(firstApproved.value.state, 1), alice, "approve", "second-by-alice"),
    });
    assert(Result.isFailure(duplicateUser));
    expect(duplicateUser.error).toBeInstanceOf(ApprovalDistinctApproverViolationError);
  });

  it("AC-M4-007: business self approvalを拒否しexecution consentでは明示許可できる", async () => {
    const { runtime: deniedRuntime, resolver } = runtime();
    const business = relationStep("business", "manager", {
      purpose: "business_approval",
      resolution: "dynamic",
      selfApproval: { mode: "deny" },
    });
    resolver.set(business.target, [alice, bob]);
    const deniedPlan = plan(business, "self-deny");
    const deniedStarted = await deniedRuntime.start({ plan: deniedPlan, startedAt });
    assert(Result.isSuccess(deniedStarted));
    expect(deniedStarted.value.tasks[0]?.candidateUserIds.map(String)).toEqual(["user:bob"]);
    const denied = await deniedRuntime.decide({
      actionRequestId: deniedPlan.actionRequestId,
      event: decision(taskId(deniedStarted.value), alice, "approve", "self"),
    });
    assert(Result.isFailure(denied));
    expect(denied.error).toBeInstanceOf(ApprovalSelfApprovalDeniedError);

    const { runtime: allowedRuntime } = runtime();
    const consent = directStep("consent", alice, {
      purpose: "execution_consent",
      selfApproval: { mode: "allow" },
    });
    const allowedPlan = plan(consent, "self-allow");
    const allowedStarted = await allowedRuntime.start({ plan: allowedPlan, startedAt });
    assert(Result.isSuccess(allowedStarted));
    const allowed = await allowedRuntime.decide({
      actionRequestId: allowedPlan.actionRequestId,
      event: decision(taskId(allowedStarted.value), alice, "approve", "self-ok"),
    });
    assert(Result.isSuccess(allowed));
    expect(allowed.value.state.status).toBe("approved");
  });

  it("AC-M4-008: expiryでterminal expiredへ遷移しauto approveしない", async () => {
    const { runtime: memory } = runtime();
    const p = plan(directStep("expiring", alice, { expiresAfter: { seconds: 60 } }), "expiry");
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    const expired = await memory.advanceTime({
      actionRequestId: p.actionRequestId,
      now: "2026-09-13T00:01:00.000Z",
    });
    assert(Result.isSuccess(expired));
    expect(expired.value.status).toBe("expired");
    expect(expired.value.tasks[0]?.status).toBe("expired");
    expect(expired.value.tasks[0]?.decisions).toEqual([]);
  });

  it("AC-M4-009: duplicate event replayで二重task/decisionを作らない", async () => {
    const { runtime: memory } = runtime();
    const p = plan(
      { type: "serial", children: [directStep("manager", alice), directStep("finance", bob)] },
      "replay",
    );
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    const event = decision(taskId(started.value), alice, "approve", "same-key");
    const first = await memory.decide({ actionRequestId: p.actionRequestId, event });
    assert(Result.isSuccess(first));
    const replay = await memory.decide({ actionRequestId: p.actionRequestId, event });
    assert(Result.isSuccess(replay));
    expect(replay.value.duplicate).toBe(true);
    expect(replay.value.state.tasks).toHaveLength(2);
    expect(replay.value.state.tasks[0]?.decisions).toHaveLength(1);
  });

  it("AC-M4-010: planのinterpreter versionを固定してdispatchする", async () => {
    const supported = runtime(new MutableResolver(), [1, 2]).runtime;
    const oldPlan = plan(directStep("old", alice), "version-old", 1);
    const oldStarted = await supported.start({ plan: oldPlan, startedAt });
    assert(Result.isSuccess(oldStarted));
    expect(oldStarted.value.interpreterSemanticsVersion).toBe(1);

    const unsupported = runtime(new MutableResolver(), [2]).runtime;
    const rejected = await unsupported.start({ plan: oldPlan, startedAt });
    assert(Result.isFailure(rejected));
    expect(rejected.error).toBeInstanceOf(UnsupportedInterpreterSemanticsVersionError);
  });

  it("AC-M4-011: invalid/closed/duplicate-user decisionを安全に拒否する", async () => {
    const { runtime: memory } = runtime();
    const step = directStep("guard", alice, { candidateCompletion: "all" });
    const p = plan(step, "invalid-decisions");
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));

    const outsider = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), bob, "approve", "outsider"),
    });
    assert(Result.isFailure(outsider));
    expect(outsider.error).toBeInstanceOf(ApprovalCandidateRejectedError);

    const accepted = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "accepted"),
    });
    assert(Result.isSuccess(accepted));

    const closed = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(accepted.value.state), alice, "reject", "closed"),
    });
    assert(Result.isFailure(closed));
    expect(closed.error).toBeInstanceOf(ApprovalTaskClosedError);
  });

  it("同じUserによる同一pending taskへの二重Decisionを拒否する", async () => {
    const { runtime: memory, resolver } = runtime();
    const step = relationStep("all", "reviewer", { candidateCompletion: "all" });
    resolver.set(step.target, [alice, bob]);
    const p = plan(step, "same-user-twice");
    const started = await memory.start({ plan: p, startedAt });
    assert(Result.isSuccess(started));
    const first = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(started.value), alice, "approve", "a-1"),
    });
    assert(Result.isSuccess(first));
    const second = await memory.decide({
      actionRequestId: p.actionRequestId,
      event: decision(taskId(first.value.state), alice, "approve", "a-2"),
    });
    assert(Result.isFailure(second));
    expect(second.error).toBeInstanceOf(ApprovalUserAlreadyDecidedError);
  });
});
