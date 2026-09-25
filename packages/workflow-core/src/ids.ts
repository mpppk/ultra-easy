import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { Brand } from "@app/approval-core";

export type WorkflowDefinitionId = Brand<string, "WorkflowDefinitionId">;
export type WorkflowRunId = Brand<string, "WorkflowRunId">;
export type NodeId = Brand<string, "NodeId">;
export type NodeRunId = Brand<string, "NodeRunId">;
export type ScopeId = Brand<string, "ScopeId">;
export type EffectId = Brand<string, "EffectId">;
export type ProgramId = Brand<string, "ProgramId">;

export type WorkflowIdKind =
  | "WorkflowDefinitionId"
  | "WorkflowRunId"
  | "NodeId"
  | "NodeRunId"
  | "ScopeId"
  | "EffectId"
  | "ProgramId";

export class InvalidWorkflowIdError extends ErrorFactory({
  name: "InvalidWorkflowIdError",
  message: ({ kind }) => `${kind}として不正な値です`,
  fields: ErrorFactory.fields<{ code: "invalid_workflow_id"; kind: WorkflowIdKind }>(),
}) {}

/**
 * Node IDはfield path（`nodes.<nodeId>.output`）とscope IDの1 segmentになるため、
 * 英字始まりの安全な識別子に限定する。
 */
const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function valid(kind: WorkflowIdKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (kind === "NodeId") return NODE_ID.test(value) && value !== "constructor";
  return value.length > 0 && value.length <= 512 && !CONTROL_CHARACTERS.test(value);
}

/** 外部境界（JSON / DB / HTTP）の値を検証してworkflowの識別子へ変換するsmart constructor。 */
export function parseWorkflowId<K extends WorkflowIdKind>(
  kind: K,
  value: unknown,
): Result.Result<Brand<string, K>, InvalidWorkflowIdError> {
  return valid(kind, value)
    ? Result.succeed(value as Brand<string, K>)
    : Result.fail(new InvalidWorkflowIdError({ code: "invalid_workflow_id", kind }));
}

export function isValidNodeId(value: string): boolean {
  return valid("NodeId", value);
}

/** コード中のliteral定数をworkflow識別子にする（外部入力には使わない）。 */
export function workflowIdLiteral<K extends WorkflowIdKind, const V extends string>(
  kind: K,
  value: string extends V ? never : V,
): Brand<V, K> {
  void kind;
  return value as V as Brand<V, K>;
}

/** scheduler内部で決定的に導出する識別子。入力は既に検証済みのIDだけを使う。 */
export function derivedWorkflowId<K extends "NodeRunId" | "ScopeId" | "EffectId">(
  kind: K,
  value: string,
): Brand<string, K> {
  void kind;
  return value as Brand<string, K>;
}

export const ROOT_SCOPE_ID: ScopeId = derivedWorkflowId("ScopeId", "root");
