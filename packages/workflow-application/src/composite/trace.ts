import { Result } from "@praha/byethrow";

import type { ActionRequestId, ActionRequestStatus, OrganizationId } from "@app/approval-core";
import type { WaitingReason, WorkflowRunStatus } from "@app/workflow-core";

import type { EffectHandlerError, WorkflowRunRepository } from "../ports.ts";
import type { ChildActionStatusReader } from "./child-actions.ts";
import type { ChildActionCorrelationRepository } from "./ports.ts";

export type ActionTraceNodeRun = {
  nodeRunId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  waitingReason?: WaitingReason;
  childActions: ActionTrace[];
};

/**
 * 監査用の相関trace（#158 / #163）:
 * `Composite ActionRequest -> WorkflowRun -> NodeRun -> child ActionRequest -> ...`
 */
export type ActionTrace = {
  actionRequestId: string;
  actionType?: string;
  status?: ActionRequestStatus;
  /** 実際の承認要件（Materialized Approval Plan）。projectionとは別物。 */
  approval?: { required: boolean; source: "materialized_plan" };
  run?: {
    runId: string;
    definitionId: string;
    version: number;
    status: WorkflowRunStatus;
    depth: number;
    nodeRuns: ActionTraceNodeRun[];
  };
};

const MAX_TRACE_DEPTH = 8;

export async function traceAction(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  actionType?: string;
  runs: WorkflowRunRepository;
  correlations: ChildActionCorrelationRepository;
  statuses: ChildActionStatusReader;
  depth?: number;
}): Result.ResultAsync<
  ActionTrace,
  EffectHandlerError | { code: string; message: string; retriable: boolean }
> {
  const status = await input.statuses.status(input);
  if (Result.isFailure(status)) return status;
  const trace: ActionTrace = {
    actionRequestId: String(input.actionRequestId),
    ...(input.actionType ? { actionType: input.actionType } : {}),
    ...(status.value ? { status: status.value.status } : {}),
    ...(status.value?.approvalRequired !== undefined
      ? {
          approval: {
            required: status.value.approvalRequired,
            source: "materialized_plan" as const,
          },
        }
      : {}),
  };
  if ((input.depth ?? 0) >= MAX_TRACE_DEPTH) return Result.succeed(trace);
  const run = await input.runs.findByParentAction(input);
  if (Result.isFailure(run)) return run;
  if (!run.value) return Result.succeed(trace);
  const children = await input.correlations.listForRun({
    organizationId: input.organizationId,
    runId: run.value.state.runId,
  });
  if (Result.isFailure(children)) return children;
  const nodeRuns: ActionTraceNodeRun[] = [];
  for (const nodeRun of Object.values(run.value.state.nodeRuns)) {
    const childActions: ActionTrace[] = [];
    for (const child of children.value.filter(
      (candidate) => String(candidate.nodeRunId) === String(nodeRun.id),
    )) {
      const childTrace = await traceAction({
        ...input,
        actionRequestId: child.childActionRequestId,
        actionType: String(child.actionType),
        depth: (input.depth ?? 0) + 1,
      });
      if (Result.isFailure(childTrace)) return childTrace;
      childActions.push(childTrace.value);
    }
    nodeRuns.push({
      nodeRunId: String(nodeRun.id),
      nodeId: String(nodeRun.nodeId),
      nodeType: nodeRun.type,
      status: nodeRun.status,
      ...(nodeRun.waitingReason ? { waitingReason: nodeRun.waitingReason } : {}),
      childActions,
    });
  }
  return Result.succeed({
    ...trace,
    run: {
      runId: String(run.value.state.runId),
      definitionId: String(run.value.state.definitionId),
      version: run.value.state.version,
      status: run.value.state.status,
      depth: run.value.depth,
      nodeRuns,
    },
  });
}
