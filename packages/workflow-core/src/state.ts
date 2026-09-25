import type { ActionType, OrganizationId, PrincipalRef, Sha256Digest } from "@app/approval-core";
import type { Condition, JsonObject, JsonValue } from "@app/expression-core";

import type { CapabilityGrant, ProgramNodeReference, WorkflowNodeType } from "./definition.ts";
import type {
  EffectId,
  NodeId,
  NodeRunId,
  ScopeId,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "./ids.ts";

export type WorkflowRunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export type NodeRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "skipped"
  | "failed"
  | "cancelled";

export type WaitingReason =
  | "waiting_action"
  | "waiting_approval"
  | "waiting_input"
  | "waiting_external"
  | "waiting_timer";

export type WorkflowFailure = {
  code: string;
  message: string;
  nodeRunId?: NodeRunId;
};

/** 1つのexecution scope（root、またはloop bodyの1 iteration）。Joinは同じscopeのedgeだけを見る。 */
export type ScopeState = {
  id: ScopeId;
  parentScopeId?: ScopeId;
  /** このscopeを生成したloop NodeRun。 */
  loopNodeRunId?: NodeRunId;
  /** root graphからbody graphへのloop Node ID列。 */
  path: NodeId[];
  iteration?: { index: number; item?: JsonValue };
  status: "running" | "succeeded" | "failed" | "cancelled";
  output?: JsonValue;
};

export type ForEachLoopState = {
  kind: "for_each";
  items: JsonValue[];
  nextIndex: number;
  running: ScopeId[];
  outputs: JsonValue[];
  completed: number;
};

export type WhileLoopState = {
  kind: "while";
  /** 次に開始するiteration番号（0始まり）。 */
  iteration: number;
  running?: ScopeId;
  lastOutput: JsonValue;
};

export type NodeRunState = {
  id: NodeRunId;
  scopeId: ScopeId;
  nodeId: NodeId;
  type: WorkflowNodeType;
  status: NodeRunStatus;
  waitingReason?: WaitingReason;
  attempt: number;
  output?: JsonValue;
  error?: WorkflowFailure;
  /** 現在in-flightの外部作用。 */
  effectId?: EffectId;
  loop?: ForEachLoopState | WhileLoopState;
  /** Program Nodeがyieldした明示的state（sandbox processは保持しない）。 */
  programState?: JsonValue;
  /** Program Nodeがyieldした外部作用の数。 */
  yieldCount?: number;
  startedAt?: string;
  completedAt?: string;
};

/** 一度だけ評価して永続化する制御フローの決定。resume時に再評価しない。 */
export type NodeDecision = {
  nodeRunId: NodeRunId;
  kind: "branch" | "for_each_items" | "while_continue" | "while_exit";
  value: JsonValue;
  iteration?: number;
  decidedAt: string;
};

export type EdgeActivation = "active" | "not_taken";

export type ActionEffectRequest = {
  kind: "action";
  actionType: ActionType;
  resource: { type: string; id: string };
  input: JsonObject;
  /** Node定義のattribute restriction（Node Agentの委任scopeへ追加する）。 */
  restriction?: Condition;
};

export type ProgramEffectRequest = {
  kind: "program";
  program: ProgramNodeReference;
  input: JsonValue;
  resume?: { state: JsonValue; effectResult: EffectOutcome };
  capabilities?: CapabilityGrant;
};

export type LlmEffectRequest = {
  kind: "llm";
  model: string;
  prompt: JsonValue;
  maxOutputTokens: number;
  capabilities?: CapabilityGrant;
};

export type TimerEffectRequest = { kind: "timer"; seconds: number };

export type HumanInputEffectRequest = { kind: "human_input"; prompt: string };

export type EffectRequest =
  | ActionEffectRequest
  | ProgramEffectRequest
  | LlmEffectRequest
  | TimerEffectRequest
  | HumanInputEffectRequest;

export type EffectOutcome =
  | { type: "completed"; output: JsonValue }
  | { type: "failed"; code: string; message: string };

/**
 * 外部作用の予約記録。IDはNodeRun + attemptから決定的に導出し、runtimeはこのIDで
 * child ActionRequest等を冪等に作る（crash / retryで重複しない）。
 */
export type EffectRecord = {
  id: EffectId;
  nodeRunId: NodeRunId;
  request: EffectRequest;
  status: "requested" | "in_flight" | "completed" | "failed" | "cancelled";
  /** Program Nodeがyieldした作用の場合、yieldしたprogram effect。 */
  parentEffectId?: EffectId;
  /** runtimeが作成した外部参照（child ActionRequest ID等）。 */
  reference?: string;
  /** retry backoff中はこの時刻まで配送しない。 */
  notBefore?: string;
  /** cancelされたin-flight作用。runtimeがchildへcancelを伝播したらtrue。 */
  cancelPropagated?: boolean;
  outcome?: EffectOutcome;
  requestedAt: string;
  completedAt?: string;
};

/** Workflow実行開始時に固定する、式評価用の非input context。 */
export type WorkflowRunContext = {
  actor: PrincipalRef;
  organizationSettings: JsonObject;
  attributes: JsonObject;
};

export type WorkflowRunState = {
  runId: WorkflowRunId;
  organizationId: OrganizationId;
  definitionId: WorkflowDefinitionId;
  version: number;
  checksum: Sha256Digest;
  status: WorkflowRunStatus;
  input: JsonObject;
  variables: JsonObject;
  context: WorkflowRunContext;
  scopes: Record<string, ScopeState>;
  nodeRuns: Record<string, NodeRunState>;
  /** `${scopeId}|${edgeId}` -> activation。schedulerの正本。 */
  edges: Record<string, EdgeActivation>;
  decisions: NodeDecision[];
  effects: Record<string, EffectRecord>;
  output?: JsonValue;
  error?: WorkflowFailure;
  counters: { nodeRuns: number };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export const TERMINAL_WORKFLOW_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return (TERMINAL_WORKFLOW_RUN_STATUSES as readonly string[]).includes(status);
}

export function isTerminalNodeRunStatus(status: NodeRunStatus): boolean {
  return (
    status === "succeeded" || status === "skipped" || status === "failed" || status === "cancelled"
  );
}

export function isEffectInFlight(effect: EffectRecord): boolean {
  return effect.status === "requested" || effect.status === "in_flight";
}
