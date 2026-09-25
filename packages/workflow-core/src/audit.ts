import type { OrganizationId } from "@app/approval-core";
import type { JsonObject } from "@app/expression-core";

import type { WorkflowRunId } from "./ids.ts";
import type { WorkflowRunState } from "./state.ts";

export type WorkflowAuditEventType =
  | "run.started"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "node.waiting"
  | "node.succeeded"
  | "node.skipped"
  | "node.failed"
  | "node.cancelled"
  | "decision.recorded"
  | "effect.requested"
  | "effect.dispatched"
  | "effect.completed"
  | "effect.failed"
  | "effect.cancelled";

/**
 * WorkflowRunの意味的な遷移を記録するappend-onlyの監査イベント。
 * outputやprompt等のpayloadは含めず、ID・code・参照（child ActionRequest ID等）だけを残す。
 */
export type WorkflowAuditEvent = {
  organizationId: OrganizationId;
  runId: WorkflowRunId;
  /** 同じ論理遷移で一致する冪等キー（retry / replayで重複しない）。 */
  eventKey: string;
  type: WorkflowAuditEventType;
  occurredAt: string;
  nodeRunId?: string;
  effectId?: string;
  data: JsonObject;
};

function event(
  state: WorkflowRunState,
  type: WorkflowAuditEventType,
  discriminator: string,
  occurredAt: string,
  data: JsonObject,
  refs: { nodeRunId?: string; effectId?: string } = {},
): WorkflowAuditEvent {
  return {
    organizationId: state.organizationId,
    runId: state.runId,
    eventKey: [String(state.organizationId), String(state.runId), type, discriminator].join(":"),
    type,
    occurredAt,
    ...(refs.nodeRunId !== undefined ? { nodeRunId: refs.nodeRunId } : {}),
    ...(refs.effectId !== undefined ? { effectId: refs.effectId } : {}),
    data,
  };
}

/** before → afterの差分から監査イベントを導出する（pure）。 */
export function workflowRunTransitionEvents(
  before: WorkflowRunState | null,
  after: WorkflowRunState,
): WorkflowAuditEvent[] {
  const events: WorkflowAuditEvent[] = [];
  const at = after.updatedAt;
  if (!before) {
    events.push(
      event(after, "run.started", "run", after.createdAt, {
        definitionId: String(after.definitionId),
        version: after.version,
        checksum: String(after.checksum),
      }),
    );
  }

  const previousDecisions = before?.decisions.length ?? 0;
  after.decisions.slice(previousDecisions).forEach((decision, offset) => {
    events.push(
      event(
        after,
        "decision.recorded",
        `${String(decision.nodeRunId)}:${decision.kind}:${decision.iteration ?? previousDecisions + offset}`,
        decision.decidedAt,
        {
          kind: decision.kind,
          ...(decision.kind === "branch" ? { selected: decision.value } : {}),
          ...(decision.kind === "for_each_items" && Array.isArray(decision.value)
            ? { itemCount: decision.value.length }
            : {}),
          ...(decision.iteration !== undefined ? { iteration: decision.iteration } : {}),
        },
        { nodeRunId: String(decision.nodeRunId) },
      ),
    );
  });

  for (const nodeRun of Object.values(after.nodeRuns)) {
    const previous = before?.nodeRuns[String(nodeRun.id)];
    const refs = { nodeRunId: String(nodeRun.id) };
    if (
      nodeRun.status === "waiting" &&
      (previous?.status !== "waiting" || previous.waitingReason !== nodeRun.waitingReason)
    ) {
      events.push(
        event(
          after,
          "node.waiting",
          `${String(nodeRun.id)}:${nodeRun.attempt}:${nodeRun.waitingReason ?? "waiting"}`,
          at,
          { nodeId: String(nodeRun.nodeId), reason: nodeRun.waitingReason ?? "waiting_external" },
          refs,
        ),
      );
    }
    if (previous?.status === nodeRun.status) continue;
    const terminalType =
      nodeRun.status === "succeeded"
        ? "node.succeeded"
        : nodeRun.status === "skipped"
          ? "node.skipped"
          : nodeRun.status === "failed"
            ? "node.failed"
            : nodeRun.status === "cancelled"
              ? "node.cancelled"
              : undefined;
    if (!terminalType) continue;
    events.push(
      event(
        after,
        terminalType,
        String(nodeRun.id),
        nodeRun.completedAt ?? at,
        {
          nodeId: String(nodeRun.nodeId),
          nodeType: nodeRun.type,
          ...(nodeRun.error ? { code: nodeRun.error.code } : {}),
        },
        refs,
      ),
    );
  }

  for (const effect of Object.values(after.effects)) {
    const previous = before?.effects[String(effect.id)];
    const refs = { nodeRunId: String(effect.nodeRunId), effectId: String(effect.id) };
    if (!previous) {
      events.push(
        event(
          after,
          "effect.requested",
          String(effect.id),
          effect.requestedAt,
          {
            kind: effect.request.kind,
            ...(effect.request.kind === "action"
              ? {
                  actionType: String(effect.request.actionType),
                  resourceType: effect.request.resource.type,
                }
              : {}),
            ...(effect.parentEffectId ? { parentEffectId: String(effect.parentEffectId) } : {}),
          },
          refs,
        ),
      );
    }
    if (effect.reference !== undefined && previous?.reference !== effect.reference) {
      events.push(
        event(
          after,
          "effect.dispatched",
          String(effect.id),
          at,
          { reference: effect.reference },
          refs,
        ),
      );
    }
    if (previous?.status === effect.status) continue;
    if (
      effect.status === "completed" ||
      effect.status === "failed" ||
      effect.status === "cancelled"
    ) {
      const type =
        effect.status === "completed"
          ? "effect.completed"
          : effect.status === "failed"
            ? "effect.failed"
            : "effect.cancelled";
      events.push(
        event(
          after,
          type,
          String(effect.id),
          effect.completedAt ?? at,
          effect.outcome?.type === "failed" ? { code: effect.outcome.code } : {},
          refs,
        ),
      );
    }
  }

  if (before?.status !== after.status) {
    const type =
      after.status === "succeeded"
        ? "run.succeeded"
        : after.status === "failed"
          ? "run.failed"
          : after.status === "cancelled"
            ? "run.cancelled"
            : undefined;
    if (type) {
      events.push(
        event(
          after,
          type,
          "run",
          after.completedAt ?? at,
          after.error ? { code: after.error.code } : {},
        ),
      );
    }
  }
  return events;
}
