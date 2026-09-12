import { ErrorFactory } from "@praha/error-factory";

import type { ApproverResolutionError } from "../approver-resolver.ts";
import type { ApprovalTaskId, MaterializedStepId, UserId } from "../domain/brand.ts";
import type { ApprovalDecisionValue, ApprovalTaskRuntimeStatus } from "./types.ts";

export class UnsupportedInterpreterSemanticsVersionError extends ErrorFactory({
  name: "UnsupportedInterpreterSemanticsVersionError",
  message: ({ version }) => `未対応のinterpreter semantics versionです: ${version}`,
  fields: ErrorFactory.fields<{
    code: "unsupported_interpreter_semantics_version";
    version: number;
  }>(),
}) {}

export class InvalidRuntimeTimestampError extends ErrorFactory({
  name: "InvalidRuntimeTimestampError",
  message: ({ value }) => `Runtime timestampが不正です: ${value}`,
  fields: ErrorFactory.fields<{
    code: "invalid_runtime_timestamp";
    value: string;
  }>(),
}) {}

export class NoEligibleApproverCandidatesError extends ErrorFactory({
  name: "NoEligibleApproverCandidatesError",
  message: "self approval / distinct approver制約適用後に承認候補者が残りませんでした。",
  fields: ErrorFactory.fields<{
    code: "no_eligible_approver_candidates";
    materializedStepId: MaterializedStepId;
  }>(),
}) {}

export class ApprovalTaskNotFoundError extends ErrorFactory({
  name: "ApprovalTaskNotFoundError",
  message: ({ taskId }) => `Approval Taskが見つかりません: ${String(taskId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_task_not_found";
    taskId: ApprovalTaskId;
  }>(),
}) {}

export class ApprovalTaskClosedError extends ErrorFactory({
  name: "ApprovalTaskClosedError",
  message: ({ taskId, status }) =>
    `closedなApproval TaskへDecisionを送信できません: ${String(taskId)} (${status})`,
  fields: ErrorFactory.fields<{
    code: "approval_task_closed";
    taskId: ApprovalTaskId;
    status: ApprovalTaskRuntimeStatus;
  }>(),
}) {}

export class ApprovalCandidateRejectedError extends ErrorFactory({
  name: "ApprovalCandidateRejectedError",
  message: ({ userId, taskId }) =>
    `Userは現在このApproval Taskを承認できません: ${String(userId)} / ${String(taskId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_candidate_rejected";
    taskId: ApprovalTaskId;
    userId: UserId;
  }>(),
}) {}

export class ApprovalUserAlreadyDecidedError extends ErrorFactory({
  name: "ApprovalUserAlreadyDecidedError",
  message: ({ userId, taskId }) =>
    `UserはこのApproval Taskへ既にDecision済みです: ${String(userId)} / ${String(taskId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_user_already_decided";
    taskId: ApprovalTaskId;
    userId: UserId;
  }>(),
}) {}

export class ApprovalSelfApprovalDeniedError extends ErrorFactory({
  name: "ApprovalSelfApprovalDeniedError",
  message: ({ userId, taskId }) =>
    `self approval policyによりDecisionを受理できません: ${String(userId)} / ${String(taskId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_self_approval_denied";
    taskId: ApprovalTaskId;
    userId: UserId;
  }>(),
}) {}

export class ApprovalDistinctApproverViolationError extends ErrorFactory({
  name: "ApprovalDistinctApproverViolationError",
  message: ({ userId, scopeId }) =>
    `distinctApprovers制約により同一Userを再利用できません: ${String(userId)} / ${scopeId}`,
  fields: ErrorFactory.fields<{
    code: "approval_distinct_approver_violation";
    taskId: ApprovalTaskId;
    userId: UserId;
    scopeId: string;
  }>(),
}) {}

export class ApprovalCommentRequiredError extends ErrorFactory({
  name: "ApprovalCommentRequiredError",
  message: ({ decision, taskId }) =>
    `${decision} Decisionにはcommentが必要です: ${String(taskId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_comment_required";
    taskId: ApprovalTaskId;
    decision: ApprovalDecisionValue;
  }>(),
}) {}

export type ApprovalInterpreterError =
  | UnsupportedInterpreterSemanticsVersionError
  | InvalidRuntimeTimestampError
  | NoEligibleApproverCandidatesError
  | ApprovalTaskNotFoundError
  | ApprovalTaskClosedError
  | ApprovalCandidateRejectedError
  | ApprovalUserAlreadyDecidedError
  | ApprovalSelfApprovalDeniedError
  | ApprovalDistinctApproverViolationError
  | ApprovalCommentRequiredError
  | ApproverResolutionError;
