import { describe, expect, it } from "vite-plus/test";

import { actionEventRecord } from "./action-event.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalStepKey,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "./domain/index.ts";
import { computeOrganizationActionSli } from "./operator-sli.ts";

const organizationId = "organization:dashboard" as OrganizationId;
const alice = "user:alice" as UserId;

function action(id: string) {
  return id as ActionRequestId;
}

function step(id: string) {
  return id as MaterializedStepId;
}

function stepKey(value: string) {
  return value as ApprovalStepKey;
}

describe("computeOrganizationActionSli", () => {
  it("lead timeとstep dwellのパーセンタイルを算出する", () => {
    const records = [
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: {
          type: "action.received",
          actionRequestId: action("action:one"),
          actor: { type: "user", id: alice },
          authority: { type: "user", id: alice },
          actionFingerprint: "fingerprint:one" as ActionFingerprint,
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:00:10.000Z",
        event: {
          type: "action.completed",
          actionRequestId: action("action:one"),
          result: "executed",
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:01:00.000Z",
        event: {
          type: "step.activated",
          actionRequestId: action("action:two"),
          materializedStepId: step("mstep:one"),
          stepKey: stepKey("manager"),
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:02:00.000Z",
        event: {
          type: "step.approved",
          actionRequestId: action("action:two"),
          materializedStepId: step("mstep:one"),
          stepKey: stepKey("manager"),
          decisionKey: "decision:one",
          actorId: alice,
        },
      }),
    ];

    const sli = computeOrganizationActionSli(records);
    expect(sli.leadTimeMs).toMatchObject({ count: 1, p50Ms: 10_000 });
    expect(sli.dwellByStepKey["manager"]).toMatchObject({ count: 1, p50Ms: 60_000 });
    expect(sli.completedByResult).toEqual({ executed: 1 });
    expect(sli.rejectedTotal).toBe(0);
    expect(sli.executorFailuresByCode).toEqual({});
  });

  it("reject/expireとexecutor失敗を集計する", () => {
    const records = [
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:01:00.000Z",
        event: {
          type: "step.activated",
          actionRequestId: action("action:three"),
          materializedStepId: step("mstep:two"),
          stepKey: stepKey("finance"),
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:01:30.000Z",
        event: {
          type: "step.rejected",
          actionRequestId: action("action:three"),
          materializedStepId: step("mstep:two"),
          stepKey: stepKey("finance"),
          decisionKey: "decision:two",
          actorId: alice,
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:02:00.000Z",
        event: {
          type: "action.execution_failed",
          actionRequestId: action("action:four"),
          code: "temporary_timeout",
          retriable: true,
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-21T00:03:00.000Z",
        event: {
          type: "action.execution_failed",
          actionRequestId: action("action:five"),
          code: "temporary_timeout",
          retriable: true,
        },
      }),
    ];

    const sli = computeOrganizationActionSli(records);
    expect(sli.rejectedTotal).toBe(1);
    expect(sli.expiredTotal).toBe(0);
    expect(sli.dwellByStepKey["finance"]).toMatchObject({ count: 1, p50Ms: 30_000 });
    expect(sli.executorFailuresByCode).toEqual({ temporary_timeout: 2 });
    expect(sli.leadTimeMs).toMatchObject({ count: 0, p50Ms: null });
  });
});
