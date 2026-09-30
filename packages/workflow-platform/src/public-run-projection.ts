import { Result } from "@praha/byethrow";

import { PublicApiRepositoryError, type ApprovalReadRepository } from "@app/approval-application";
import type { ActionRequestView } from "@app/approval-application";
import type { OrganizationId } from "@app/approval-core";
import { WorkflowRepositoryError } from "@app/workflow-application";
import { allNodes, type WorkflowAuditEvent } from "@app/workflow-core";
import { allRows, parseJson } from "@app/workflow-d1";
import type { D1DatabaseLike } from "@app/workflow-d1";
import type { WorkflowRunRecord } from "@app/workflow-application";

import type { WorkflowPlatform } from "./platform.ts";

export type PublicWorkflowRunView = {
  id: string;
  actionRequestId: string;
  actionType: string;
  organizationId: string;
  status:
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "rejected";
  correlation: Record<string, string>;
  requestedBy: { id: string; displayName: string };
  startedAt: string;
  updatedAt: string;
  nodes: Array<{
    key: string;
    label: string;
    status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped" | "cancelled";
    childActionRequestId?: string;
    errorCode?: string;
  }>;
  childActions: Array<{
    actionRequestId: string;
    actionType: string;
    status: "pending" | "waiting_approval" | "succeeded" | "failed" | "rejected" | "cancelled";
    subjectResourceId?: string;
    approvalTaskId?: string;
    errorCode?: string;
  }>;
  approvals: Array<{
    taskId: string;
    actionRequestId: string;
    actionType: string;
    status: "pending" | "approved" | "rejected" | "cancelled";
    candidateIds: string[];
    url: string;
  }>;
  /** Prompt and answer are provided by the governed Human Input API (#197). */
  humanInputs: Array<{ key: string; status: "waiting" | "answered" | "failed" | "cancelled" }>;
  failure: { code: string; message: string; nodeKey: string } | null;
  audit: Array<{ at: string; type: string; actionRequestId: string; detail: string }>;
};

export type PublicRunProjectionError = WorkflowRepositoryError | PublicApiRepositoryError;

type ApprovalTaskRow = {
  task_id: string;
  action_request_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  candidate_user_ids: string;
};

function childStatus(
  status: ActionRequestView["status"],
): PublicWorkflowRunView["childActions"][number]["status"] {
  if (status === "executed") return "succeeded";
  if (status === "rejected" || status === "expired") return "rejected";
  if (status === "cancelled") return "cancelled";
  if (status === "pending_approval") return "waiting_approval";
  if (
    status === "failed" ||
    status === "execution_failed" ||
    status === "execution_unknown" ||
    status === "authorization_revoked" ||
    status === "authorization_check_failed"
  )
    return "failed";
  return "pending";
}

function nodeStatus(
  status: WorkflowRunRecord["state"]["nodeRuns"][string]["status"],
): PublicWorkflowRunView["nodes"][number]["status"] {
  return status === "ready" ? "pending" : status;
}

function auditEntry(
  event: WorkflowAuditEvent,
  parentActionRequestId: string,
  childByEffect: Map<string, string>,
): PublicWorkflowRunView["audit"][number] {
  const child = event.effectId ? childByEffect.get(event.effectId) : undefined;
  return {
    at: event.occurredAt,
    type: event.type,
    actionRequestId: child ?? parentActionRequestId,
    // Audit payloads can contain branch values or provider text. Only the fixed event type is public.
    detail: event.type,
  };
}

function projectionError(code: string): WorkflowRepositoryError {
  return new WorkflowRepositoryError(code, false, code);
}

/** Build an allowlisted view only after the caller has been authorized for the parent ActionRequest. */
export async function projectPublicWorkflowRun(input: {
  db: D1DatabaseLike;
  platform: WorkflowPlatform;
  readRepository: ApprovalReadRepository;
  organizationId: OrganizationId;
  record: WorkflowRunRecord;
  parent: ActionRequestView;
}): Result.ResultAsync<PublicWorkflowRunView, PublicRunProjectionError> {
  const { organizationId, record, platform, parent } = input;
  const state = record.state;
  if (
    String(state.organizationId) !== String(organizationId) ||
    String(parent.organizationId) !== String(organizationId) ||
    String(record.invocation.parentAction?.actionRequestId) !== String(parent.id)
  ) {
    return Result.fail(projectionError("workflow_parent_mismatch"));
  }

  const version = await platform.repositories.versions.load({
    organizationId,
    definitionId: state.definitionId,
    version: state.version,
  });
  if (Result.isFailure(version)) return version;
  if (!version.value) return Result.fail(projectionError("workflow_version_not_found"));
  const events = await platform.repositories.runs.listEvents({
    organizationId,
    runId: state.runId,
  });
  if (Result.isFailure(events)) return events;
  const correlations = await platform.repositories.correlations.listForRun({
    organizationId,
    runId: state.runId,
  });
  if (Result.isFailure(correlations)) return correlations;

  const childViews = new Map<string, ActionRequestView>();
  for (const child of correlations.value) {
    const loaded = await input.readRepository.getActionRequest({
      organizationId,
      actionRequestId: child.childActionRequestId,
    });
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value) return Result.fail(projectionError("workflow_child_action_not_found"));
    childViews.set(String(child.childActionRequestId), loaded.value);
  }

  const actionIds = [String(parent.id), ...childViews.keys()];
  const tasks = await allRows<ApprovalTaskRow>(
    input.db
      .prepare(
        `SELECT task_id, action_request_id, status, candidate_user_ids
           FROM approval_tasks
          WHERE organization_id = ?
            AND action_request_id IN (SELECT value FROM json_each(?))
          ORDER BY action_request_id, task_id`,
      )
      .bind(String(organizationId), JSON.stringify(actionIds)),
  );
  if (Result.isFailure(tasks)) return tasks;

  const tasksByAction = new Map<string, ApprovalTaskRow[]>();
  const approvals: PublicWorkflowRunView["approvals"] = [];
  for (const task of tasks.value) {
    const candidates = parseJson<unknown>(task.candidate_user_ids);
    if (Result.isFailure(candidates)) return candidates;
    if (
      !Array.isArray(candidates.value) ||
      !candidates.value.every((id) => typeof id === "string")
    ) {
      return Result.fail(projectionError("approval_task_candidates_invalid"));
    }
    const action =
      task.action_request_id === String(parent.id)
        ? parent
        : childViews.get(task.action_request_id);
    if (!action) return Result.fail(projectionError("approval_task_action_not_found"));
    const rows = tasksByAction.get(task.action_request_id) ?? [];
    rows.push(task);
    tasksByAction.set(task.action_request_id, rows);
    approvals.push({
      taskId: task.task_id,
      actionRequestId: task.action_request_id,
      actionType: String(action.action.type),
      status: task.status === "expired" ? "cancelled" : task.status,
      candidateIds: candidates.value as string[],
      url: `/v1/organizations/${encodeURIComponent(String(organizationId))}/approval-tasks/${encodeURIComponent(task.task_id)}`,
    });
  }

  const childByNode = new Map(
    correlations.value.map((child) => [
      String(child.nodeRunId),
      String(child.childActionRequestId),
    ]),
  );
  const childByEffect = new Map(
    correlations.value.map((child) => [String(child.effectId), String(child.childActionRequestId)]),
  );
  const labels = new Map(
    allNodes(version.value.definition.graph).map(({ node }) => [
      String(node.id),
      node.label ?? String(node.id),
    ]),
  );
  const nodes = Object.values(state.nodeRuns).map((node) => ({
    key: String(node.id),
    label: labels.get(String(node.nodeId)) ?? String(node.nodeId),
    status: nodeStatus(node.status),
    ...(childByNode.has(String(node.id))
      ? { childActionRequestId: childByNode.get(String(node.id)) }
      : {}),
    ...(node.error ? { errorCode: "node_failed" } : {}),
  }));
  const childActions = correlations.value.map((child) => {
    const view = childViews.get(String(child.childActionRequestId))!;
    const task = tasksByAction.get(String(child.childActionRequestId))?.[0];
    return {
      actionRequestId: String(child.childActionRequestId),
      actionType: String(child.actionType),
      status: childStatus(view.status),
      subjectResourceId: String(view.action.resource.id),
      ...(task ? { approvalTaskId: task.task_id } : {}),
      ...(view.result?.code ? { errorCode: "action_failed" } : {}),
    };
  });
  const humanInputs = Object.values(state.effects)
    .filter((effect) => effect.request.kind === "human_input")
    .map((effect) => ({
      key: String(effect.id),
      status:
        effect.status === "completed"
          ? ("answered" as const)
          : effect.status === "failed"
            ? ("failed" as const)
            : effect.status === "cancelled"
              ? ("cancelled" as const)
              : ("waiting" as const),
    }));
  const status: PublicWorkflowRunView["status"] =
    parent.status === "rejected"
      ? "rejected"
      : state.status === "waiting" && humanInputs.some((item) => item.status === "waiting")
        ? "waiting_input"
        : state.status === "waiting" && approvals.some((item) => item.status === "pending")
          ? "waiting_approval"
          : state.status === "waiting"
            ? "running"
            : state.status;

  return Result.succeed({
    id: String(state.runId),
    actionRequestId: String(parent.id),
    actionType: String(parent.action.type),
    organizationId: String(organizationId),
    status,
    correlation: parent.correlation ?? {},
    requestedBy: { id: String(parent.actor.id), displayName: String(parent.actor.id) },
    startedAt: state.createdAt,
    updatedAt: state.updatedAt,
    nodes,
    childActions,
    approvals,
    humanInputs,
    failure: state.error
      ? {
          code: "workflow_failed",
          message: "Workflow failed",
          nodeKey: String(state.error.nodeRunId ?? ""),
        }
      : null,
    audit: events.value.map((event) => auditEntry(event, String(parent.id), childByEffect)),
  });
}
