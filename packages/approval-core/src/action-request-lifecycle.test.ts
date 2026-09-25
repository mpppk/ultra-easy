import { describe, expect, it } from "vite-plus/test";

import type { ActionEvent } from "./action-event.ts";
import {
  ACTION_REQUEST_TRANSITIONS,
  applyActionRequestEvent,
  canTransitionActionRequest,
  foldActionRequestStatus,
  isTerminalActionRequestStatus,
  type ActionRequestStatus,
} from "./action-request-lifecycle.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalPlanChecksum,
  ApprovalStepKey,
  ApprovalTaskId,
  EvaluationSnapshotChecksum,
  MaterializedStepId,
  UserId,
} from "./domain/brand.ts";

const actionRequestId = "action:lifecycle" as ActionRequestId;
const user = "user:alice" as UserId;

const EVENTS = {
  received: {
    type: "action.received",
    actionRequestId,
    actor: { type: "user", id: user },
    authority: { type: "user", id: user },
    actionFingerprint: "sha256:a" as ActionFingerprint,
  },
  authorized: {
    type: "action.authorized",
    actionRequestId,
    evidence: { evaluatedAt: "2026-09-25T00:00:00.000Z", consistency: "minimize_latency" },
  },
  materialized: {
    type: "approval_plan.materialized",
    actionRequestId,
    evaluationSnapshotChecksum: "sha256:s" as EvaluationSnapshotChecksum,
    approvalPlanChecksum: "sha256:p" as ApprovalPlanChecksum,
    interpreterSemanticsVersion: 1,
  },
  workflowStarted: { type: "workflow.started", actionRequestId, workflowInstanceId: "wf" },
  stepActivated: {
    type: "step.activated",
    actionRequestId,
    materializedStepId: "mstep:1" as MaterializedStepId,
    stepKey: "manager" as ApprovalStepKey,
  },
  stepApproved: {
    type: "step.approved",
    actionRequestId,
    materializedStepId: "mstep:1" as MaterializedStepId,
    stepKey: "manager" as ApprovalStepKey,
    decisionKey: "d1",
    actorId: user,
  },
  decisionRejected: {
    type: "approval_decision.rejected",
    actionRequestId,
    taskId: "task:1" as ApprovalTaskId,
    decisionKey: "d0",
    actorId: user,
    decision: "approve",
    code: "approval_candidate_rejected",
  },
  approved: { type: "approval.approved", actionRequestId },
  reauthorized: {
    type: "action.reauthorized",
    actionRequestId,
    evidence: { evaluatedAt: "2026-09-25T00:01:00.000Z", consistency: "higher_consistency" },
  },
  executionStarted: { type: "action.execution_started", actionRequestId, idempotencyKey: "k" },
  workflowFailed: {
    type: "workflow.failed",
    actionRequestId,
    workflowInstanceId: "wf",
    code: "approval_runtime_projection_conflict",
  },
} satisfies Record<string, ActionEvent>;

function completed(result: Extract<ActionEvent, { type: "action.completed" }>["result"]) {
  return { type: "action.completed", actionRequestId, result } satisfies ActionEvent;
}

const approval = { approvalRequired: true };
const noApproval = { approvalRequired: false };

describe("#101 ActionRequest lifecycle", () => {
  it("承認ありのhappy pathを状態遷移表に沿って導出する", () => {
    const path: [ActionEvent, ActionRequestStatus][] = [
      [EVENTS.received, "evaluating"],
      [EVENTS.authorized, "evaluating"],
      [EVENTS.materialized, "pending_approval"],
      [EVENTS.workflowStarted, "pending_approval"],
      [EVENTS.stepActivated, "pending_approval"],
      [EVENTS.decisionRejected, "pending_approval"],
      [EVENTS.stepApproved, "pending_approval"],
      [EVENTS.approved, "approved"],
      [EVENTS.reauthorized, "executing"],
      [EVENTS.executionStarted, "executing"],
      [completed("executed"), "executed"],
    ];
    let status: ActionRequestStatus = "evaluating";
    for (const [event, expected] of path) {
      status = applyActionRequestEvent(status, event, approval);
      expect(status, event.type).toBe(expected);
    }
    expect(
      foldActionRequestStatus(
        path.map(([event]) => event),
        approval,
      ),
    ).toBe("executed");
  });

  it("承認不要の同期実行、却下、force-cancel、Workflow異常終了を導出する", () => {
    expect(
      foldActionRequestStatus(
        [EVENTS.received, EVENTS.authorized, EVENTS.materialized, EVENTS.reauthorized],
        noApproval,
      ),
    ).toBe("executing");
    expect(
      foldActionRequestStatus(
        [EVENTS.received, EVENTS.materialized, EVENTS.stepActivated, completed("rejected")],
        approval,
      ),
    ).toBe("rejected");
    expect(
      foldActionRequestStatus(
        [EVENTS.received, EVENTS.materialized, completed("cancelled")],
        approval,
      ),
    ).toBe("cancelled");
    expect(
      foldActionRequestStatus(
        [EVENTS.received, EVENTS.materialized, EVENTS.workflowStarted, EVENTS.workflowFailed],
        approval,
      ),
    ).toBe("failed");
  });

  it("終端状態はabsorbingで、後から届いたeventで後退しない", () => {
    const status = foldActionRequestStatus(
      [
        EVENTS.received,
        EVENTS.materialized,
        completed("cancelled"),
        EVENTS.stepApproved,
        EVENTS.approved,
        EVENTS.reauthorized,
        completed("executed"),
      ],
      approval,
    );
    expect(status).toBe("cancelled");
  });

  it("action.receivedを持たない#85以前のActionRequestはapproval要否から初期状態を補う", () => {
    expect(foldActionRequestStatus([EVENTS.workflowStarted, EVENTS.stepActivated], approval)).toBe(
      "pending_approval",
    );
    expect(foldActionRequestStatus([], noApproval)).toBe("evaluating");
    expect(foldActionRequestStatus([], approval)).toBe("pending_approval");
  });

  it("状態遷移表: 終端状態は遷移先を持たず、非終端状態はfailedへ遷移できる", () => {
    for (const [from, targets] of Object.entries(ACTION_REQUEST_TRANSITIONS) as [
      ActionRequestStatus,
      readonly ActionRequestStatus[],
    ][]) {
      if (isTerminalActionRequestStatus(from)) {
        expect(targets, from).toEqual([]);
      } else {
        expect(targets, from).toContain("failed");
      }
    }
  });

  it("property: 任意のevent列でも、各stepの遷移は状態遷移表に含まれ、終端は保たれる", () => {
    const vocabulary: ActionEvent[] = [
      ...Object.values(EVENTS),
      completed("executed"),
      completed("rejected"),
      completed("cancelled"),
      completed("expired"),
      completed("authorization_revoked"),
      completed("authorization_check_failed"),
      completed("execution_failed"),
      completed("execution_unknown"),
    ];
    // 再現可能な擬似乱数（mulberry32）
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    for (let run = 0; run < 2000; run += 1) {
      const context = random() < 0.5 ? approval : noApproval;
      const length = 1 + Math.floor(random() * 12);
      const events = Array.from(
        { length },
        () => vocabulary[Math.floor(random() * vocabulary.length)]!,
      );
      let status = foldActionRequestStatus(events.slice(0, 0), context);
      let reachedTerminal = false;
      for (const event of events) {
        const next = applyActionRequestEvent(status, event, context);
        expect(canTransitionActionRequest(status, next)).toBe(true);
        if (reachedTerminal) expect(next).toBe(status);
        reachedTerminal ||= isTerminalActionRequestStatus(next);
        status = next;
      }
    }
  });
});
