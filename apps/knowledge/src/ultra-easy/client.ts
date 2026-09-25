import type { Result } from "@praha/byethrow";

import type { SpaceRole } from "@app/knowledge-core";

/**
 * The ultra-easy public surface the Knowledge app integrates with (#167).
 *
 * Knowledge never imports approval / workflow runtime packages. Everything it
 * needs from the platform goes through this port: authorization relationships,
 * ActionRequests (Composite Actions run by the Workflow Engine), run
 * projections, Human Input and governed policy updates.
 *
 * The Workflow Engine public API is still being built (#154-#165), so the only
 * implementation today is `MockUltraEasy` (./mock). A Service Binding / HTTP
 * implementation replaces it without touching Knowledge code.
 */

export type PrincipalRef = { id: string; displayName: string };

export class UltraEasyError extends Error {
  constructor(
    readonly code:
      | "platform_unavailable"
      | "not_found"
      | "forbidden"
      | "invalid_request"
      | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "UltraEasyError";
  }
}

export type KnowledgeActionType =
  | "knowledge.publish_document"
  | "knowledge.maintain_space"
  | "knowledge.search.reindex"
  | "knowledge.watchers.notify"
  | "knowledge.page.archive";

export type ActionCorrelation = {
  spaceId: string;
  pageId?: string;
  publicationSnapshotId?: string;
};

export type StartActionInput = {
  organizationId: string;
  /** Trusted principal resolved server-side from the Knowledge session. */
  actor: PrincipalRef;
  actionType: KnowledgeActionType;
  resource: { type: "knowledge_page" | "knowledge_space"; id: string };
  input: Record<string, unknown>;
  correlation: ActionCorrelation;
  idempotencyKey: string;
};

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rejected";

export type NodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

/** User-facing node timeline entry (never the raw workflow graph). */
export type RunNode = {
  key: string;
  label: string;
  status: NodeStatus;
  detail?: string;
  childActionRequestId?: string;
  errorCode?: string;
};

export type ApprovalTaskRef = {
  taskId: string;
  actionRequestId: string;
  actionType: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  candidateIds: string[];
  url: string;
};

export type HumanInputRequest = {
  key: string;
  subject: { pageId: string; title: string };
  prompt: string;
  /** Untrusted LLM suggestion shown as context only. */
  analysis: string;
  assigneeId: string;
  options: string[];
  status: "waiting" | "answered";
  answer?: string;
  answeredBy?: string;
};

export type ChildActionRef = {
  actionRequestId: string;
  actionType: string;
  status: "pending" | "waiting_approval" | "succeeded" | "failed" | "rejected" | "cancelled";
  subjectPageId?: string;
  approvalTaskId?: string;
  errorCode?: string;
};

export type AuditEventRef = {
  at: string;
  type: string;
  actionRequestId: string;
  detail: string;
};

export type WorkflowRunView = {
  id: string;
  actionRequestId: string;
  actionType: KnowledgeActionType;
  organizationId: string;
  status: RunStatus;
  correlation: ActionCorrelation;
  requestedBy: PrincipalRef;
  startedAt: string;
  updatedAt: string;
  nodes: RunNode[];
  childActions: ChildActionRef[];
  approvals: ApprovalTaskRef[];
  humanInputs: HumanInputRequest[];
  failure: { code: string; message: string; nodeKey: string } | null;
  audit: AuditEventRef[];
};

export type StartActionResult = {
  actionRequestId: string;
  run: WorkflowRunView;
};

/** Approval rule presets Knowledge compiles into an ultra-easy policy binding. */
export type ApprovalApprover = "space_owners" | "page_owner";

export type CompiledPolicyRule = {
  key: string;
  actionType: "knowledge.revision.publish" | "knowledge.page.archive";
  /** Serializable condition over the child ActionRequest input. */
  when: { field: string; equals: string } | { always: true } | { requesterIsNot: "page_owner" };
  approvers: ApprovalApprover;
};

export type CompiledPolicy = { rules: CompiledPolicyRule[] };

export type PolicyBindingView = {
  spaceId: string;
  version: number;
  policy: CompiledPolicy;
  pendingChange: { actionRequestId: string; approvalUrl: string; policy: CompiledPolicy } | null;
};

export interface UltraEasyClient {
  // Authorization (ultra-easy / OpenFGA relationships)
  listPrincipals(organizationId: string): Result.ResultAsync<PrincipalRef[], UltraEasyError>;
  spaceRoles(input: {
    organizationId: string;
    principalId: string;
  }): Result.ResultAsync<Map<string, SpaceRole>, UltraEasyError>;
  spaceMembers(input: {
    organizationId: string;
    spaceId: string;
  }): Result.ResultAsync<Array<{ principal: PrincipalRef; role: SpaceRole }>, UltraEasyError>;
  grantSpaceRole(input: {
    organizationId: string;
    principalId: string;
    spaceId: string;
    role: SpaceRole;
  }): Result.ResultAsync<void, UltraEasyError>;

  // ActionRequests / Workflow runs
  startAction(input: StartActionInput): Result.ResultAsync<StartActionResult, UltraEasyError>;
  cancelAction(input: {
    organizationId: string;
    actionRequestId: string;
    actor: PrincipalRef;
  }): Result.ResultAsync<WorkflowRunView, UltraEasyError>;
  getRun(input: {
    organizationId: string;
    runId: string;
  }): Result.ResultAsync<WorkflowRunView | null, UltraEasyError>;
  findRunByActionRequest(input: {
    organizationId: string;
    actionRequestId: string;
  }): Result.ResultAsync<WorkflowRunView | null, UltraEasyError>;
  listRuns(input: {
    organizationId: string;
    spaceIds: readonly string[];
    limit: number;
  }): Result.ResultAsync<WorkflowRunView[], UltraEasyError>;
  submitHumanInput(input: {
    organizationId: string;
    runId: string;
    inputKey: string;
    answer: string;
    actor: PrincipalRef;
  }): Result.ResultAsync<WorkflowRunView, UltraEasyError>;

  // Governed approval policy (approval_policy_binding.update)
  getPolicyBinding(input: {
    organizationId: string;
    spaceId: string;
  }): Result.ResultAsync<PolicyBindingView, UltraEasyError>;
  proposePolicyBinding(input: {
    organizationId: string;
    spaceId: string;
    policy: CompiledPolicy;
    actor: PrincipalRef;
  }): Result.ResultAsync<PolicyBindingView, UltraEasyError>;

  /** Deep link into the ultra-easy Approval UI (Knowledge never decides approvals). */
  approvalUrl(taskId: string): string;
  /** Link to the generic policy editor in ultra-easy Admin. */
  adminPolicyUrl(spaceId: string): string;
}
