import { assert, describe, expect, it } from "vite-plus/test";

import {
  InMemoryFixedWindowRateLimiter,
  actionEventRecord,
  deriveApprovalSliMetrics,
  safeActionEventLogRecord,
} from "@app/approval-core";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalStepKey,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "@app/approval-core";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("organization:m7-observability");
const actionRequestId = branded<ActionRequestId>("action:m7-observability");
const alice = branded<UserId>("user:alice");
const bob = branded<UserId>("user:bob");
const stepId = branded<MaterializedStepId>("step:manager");
const stepKey = branded<ApprovalStepKey>("manager");

describe("M7 observability / log safety / rate limiting", () => {
  it("AC-M7-008: append-only Action eventsからapproval lead/dwell/reject/expire/executor SLIを導出する", () => {
    const records = [
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:00:00.000Z",
        event: {
          type: "action.received",
          actionRequestId,
          actor: { type: "user", id: alice },
          authority: { type: "user", id: alice },
          actionFingerprint: branded<ActionFingerprint>("sha256:m7-observability"),
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:01:00.000Z",
        event: {
          type: "step.activated",
          actionRequestId,
          materializedStepId: stepId,
          stepKey,
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:03:00.000Z",
        event: {
          type: "step.rejected",
          actionRequestId,
          materializedStepId: stepId,
          stepKey,
          decisionKey: "decision:1",
          actorId: bob,
          comment: "sensitive decision comment that must never enter default logs",
        },
      }),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:05:00.000Z",
        event: {
          type: "action.completed",
          actionRequestId,
          result: "rejected",
        },
      }),
    ];

    const metrics = deriveApprovalSliMetrics(records);
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "approval.step_dwell_time_ms",
          value: 120_000,
          unit: "milliseconds",
        }),
        expect.objectContaining({
          name: "approval.rejected_total",
          value: 1,
          unit: "count",
        }),
        expect.objectContaining({
          name: "approval.lead_time_ms",
          value: 300_000,
          unit: "milliseconds",
        }),
      ]),
    );
    expect(
      metrics
        .filter((metric) => metric.correlation)
        .every((metric) => metric.correlation?.correlationId === String(actionRequestId)),
    ).toBe(true);
  });

  it("AC-M7-009: default domain-event logはDecision comment等の非allow-list情報を含めない", () => {
    const secret = "CONFIDENTIAL-COMMENT-123";
    const record = actionEventRecord({
      organizationId,
      occurredAt: "2026-09-20T00:03:00.000Z",
      event: {
        type: "step.approved",
        actionRequestId,
        materializedStepId: stepId,
        stepKey,
        decisionKey: "decision:secret",
        actorId: bob,
        comment: secret,
      },
    });

    const log = safeActionEventLogRecord(record);
    const serialized = JSON.stringify(log);

    expect(log.correlation.correlationId).toBe(String(actionRequestId));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"comment"');
    expect(serialized).not.toContain("decision:secret");
    expect(log.attributes).toMatchObject({
      eventType: "step.approved",
      materializedStepId: String(stepId),
      stepKey: String(stepKey),
    });
  });

  it("AC-M7-007/009: correlation rootはActionRequest IDでsafe attributesだけを持つ", () => {
    const log = safeActionEventLogRecord(
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:00:00.000Z",
        event: {
          type: "action.execution_failed",
          actionRequestId,
          code: "provider_unavailable",
          retriable: true,
        },
      }),
      "executor",
    );

    expect(log.correlation).toMatchObject({
      organizationId,
      actionRequestId,
      correlationId: String(actionRequestId),
      component: "executor",
      operation: "action.execution_failed",
    });
    expect(log.attributes).toEqual({
      eventType: "action.execution_failed",
      errorCode: "provider_unavailable",
      retriable: true,
    });
  });

  it("rate limit usageはtenant / principal / operationごとに分離される", async () => {
    const limiter = new InMemoryFixedWindowRateLimiter();
    const policy = { limit: 1, windowSeconds: 60 };
    const now = "2026-09-20T00:00:10.000Z";

    const consume = (input: {
      organizationId: OrganizationId;
      userId: UserId;
      operation: "action_request.submit" | "approval_decision.submit";
    }) =>
      limiter.consume({
        organizationId: input.organizationId,
        principal: { type: "user", id: input.userId },
        operation: input.operation,
        policy,
        now,
      });

    const first = await consume({
      organizationId,
      userId: alice,
      operation: "action_request.submit",
    });
    const sameScope = await consume({
      organizationId,
      userId: alice,
      operation: "action_request.submit",
    });
    const otherTenant = await consume({
      organizationId: branded<OrganizationId>("organization:other"),
      userId: alice,
      operation: "action_request.submit",
    });
    const otherPrincipal = await consume({
      organizationId,
      userId: bob,
      operation: "action_request.submit",
    });
    const otherOperation = await consume({
      organizationId,
      userId: alice,
      operation: "approval_decision.submit",
    });

    assert(first.type === "success");
    assert(sameScope.type === "success");
    assert(otherTenant.type === "success");
    assert(otherPrincipal.type === "success");
    assert(otherOperation.type === "success");
    expect(first.value.allowed).toBe(true);
    expect(sameScope.value.allowed).toBe(false);
    expect(otherTenant.value.allowed).toBe(true);
    expect(otherPrincipal.value.allowed).toBe(true);
    expect(otherOperation.value.allowed).toBe(true);
  });
});
