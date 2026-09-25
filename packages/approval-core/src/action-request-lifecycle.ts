import type { ActionEvent } from "./action-event.ts";

/**
 * ActionRequestの状態（#101）。domain event（action_events）をfoldして導出し、read API・
 * submit応答・MCP・Workflow出力はこの型と`foldActionRequestStatus`だけを使う（各adapterで独自に
 * 推測しない）。
 *
 * - evaluating: 受付済み。Plan確定前
 * - pending_approval: 承認待ち（Workflow起動済み）
 * - approved: 承認完了、または承認不要。再認可前
 * - executing: 再認可済みでExecutorを呼び出した（結果未確定）。async executorがacceptedを返した場合も
 *   trusted completionで終端するまでここに留まる（#165）
 * - failed: Workflowが異常終了した（状態を進められない。runbookで調査する）
 * - それ以外: 終端
 */
export type ActionRequestStatus =
  | "evaluating"
  | "pending_approval"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "authorization_revoked"
  | "authorization_check_failed"
  | "execution_failed"
  | "execution_unknown"
  | "failed";

export const TERMINAL_ACTION_REQUEST_STATUSES = [
  "executed",
  "rejected",
  "cancelled",
  "expired",
  "authorization_revoked",
  "authorization_check_failed",
  "execution_failed",
  "execution_unknown",
  "failed",
] as const satisfies readonly ActionRequestStatus[];

export function isTerminalActionRequestStatus(status: ActionRequestStatus): boolean {
  return (TERMINAL_ACTION_REQUEST_STATUSES as readonly ActionRequestStatus[]).includes(status);
}

/**
 * 許可される状態遷移（状態遷移表）。終端状態からの遷移は無い（absorbing）。
 * `failed`はどの非終端状態からも起こりうる（Workflowの異常終了）。
 */
export const ACTION_REQUEST_TRANSITIONS: Readonly<
  Record<ActionRequestStatus, readonly ActionRequestStatus[]>
> = {
  evaluating: ["pending_approval", "approved", "failed"],
  pending_approval: ["approved", "rejected", "cancelled", "expired", "failed"],
  approved: ["executing", "authorization_revoked", "authorization_check_failed", "failed"],
  executing: ["executed", "execution_failed", "execution_unknown", "failed"],
  executed: [],
  rejected: [],
  cancelled: [],
  expired: [],
  authorization_revoked: [],
  authorization_check_failed: [],
  execution_failed: [],
  execution_unknown: [],
  failed: [],
};

export function canTransitionActionRequest(
  from: ActionRequestStatus,
  to: ActionRequestStatus,
): boolean {
  return from === to || ACTION_REQUEST_TRANSITIONS[from].includes(to);
}

export type ActionRequestLifecycleContext = {
  /** Materialized Planのflowがnoneでないか（approval_plan.materializedの遷移先を決める）。 */
  approvalRequired: boolean;
};

/** 1つのdomain eventが示す遷移先。状態を変えないeventはnull。 */
function targetOf(
  event: ActionEvent,
  context: ActionRequestLifecycleContext,
): ActionRequestStatus | null {
  switch (event.type) {
    case "action.received":
      return "evaluating";
    case "approval_plan.materialized":
      return context.approvalRequired ? "pending_approval" : "approved";
    case "approval.approved":
      return "approved";
    case "action.reauthorized":
    case "action.execution_started":
    case "action.execution_accepted":
      return "executing";
    case "action.completed":
      return event.result;
    case "workflow.failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * 現在の状態にeventを適用する。遷移表に無い遷移（終端後のevent、順序の崩れた再送等）は
 * 無視して現在の状態を保つ（append-only logの再生で状態が後退しない）。
 */
export function applyActionRequestEvent(
  current: ActionRequestStatus,
  event: ActionEvent,
  context: ActionRequestLifecycleContext,
): ActionRequestStatus {
  const target = targetOf(event, context);
  if (target === null || target === current) return current;
  // action.receivedは初期状態でだけ意味を持つ
  if (event.type === "action.received") return current;
  return canTransitionActionRequest(current, target) ? target : current;
}

/**
 * domain eventの列からActionRequestの状態を導出する（純粋関数）。
 * 初期状態はevaluating。`action.received`を持たない古いActionRequest（#85以前）は、
 * approval要否から初期状態を補う。
 */
export function foldActionRequestStatus(
  events: readonly ActionEvent[],
  context: ActionRequestLifecycleContext,
): ActionRequestStatus {
  const first = events[0];
  const initial: ActionRequestStatus =
    first?.type === "action.received"
      ? "evaluating"
      : context.approvalRequired
        ? "pending_approval"
        : first === undefined
          ? "evaluating"
          : "approved";
  return events.reduce<ActionRequestStatus>(
    (status, event) => applyActionRequestEvent(status, event, context),
    initial,
  );
}
