import type { ActionType, PrincipalRef, Sha256Digest } from "@app/approval-core";
import type {
  Condition,
  FieldDefinition,
  JsonObject,
  ValueExpression,
  ValueTemplate,
} from "@app/expression-core";

import type { NodeId, ProgramId, WorkflowDefinitionId } from "./ids.ts";

type NodeBase = {
  id: NodeId;
  label?: string;
  /** Workflow Studio上の配置。実行意味は持たない。 */
  position?: { x: number; y: number };
};

/** Root graphの唯一の入口。outputはworkflow input。 */
export type TriggerNode = NodeBase & { type: "trigger" };

/**
 * 副作用を伴う唯一の経路。executorやprotocol（MCP / gRPC等）を直接指定せず、Action Catalog上の
 * ActionTypeを参照する。Composite Action（別Workflow）も同じ形で呼ぶ（Subworkflow専用Nodeは持たない）。
 */
export type ActionNode = NodeBase & {
  type: "action";
  actionType: ActionType;
  resource: { type: string; id: ValueExpression };
  input: ValueTemplate;
  /**
   * Node Agentへの委任scopeへ追加するattribute restriction（delegation namespace）。
   * 例: `action.input.amount <= 10000`。
   */
  restriction?: Condition;
  retry?: RetryPolicy;
};

export type BranchCase = { key: string; when: Condition };

/** 最初に一致したcaseのedge（`edge.branch === key`）だけをactiveにする。 */
export type BranchNode = NodeBase & {
  type: "branch";
  cases: BranchCase[];
  /** どのcaseにも一致しない場合のkey。無ければNodeを失敗させる（fail-closed）。 */
  defaultKey?: string;
};

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

/** collectionの各要素でbodyを独立したiteration scopeとして実行する。outputは要素順の配列。 */
export type ForEachNode = NodeBase & {
  type: "for_each";
  collection: ValueExpression;
  /** 同時に実行するiteration数（1以上）。 */
  concurrency: number;
  /** 受け付ける要素数の上限。超過はNodeの失敗。 */
  maxItems: number;
  body: WorkflowGraph;
};

/** iteration開始前にconditionを評価する。maxIterationsは必須。 */
export type WhileNode = NodeBase & {
  type: "while";
  condition: Condition;
  maxIterations: number;
  body: WorkflowGraph;
};

export type TransformNode = NodeBase & {
  type: "transform";
  output: ValueTemplate;
  /** workflow variablesへの代入（`variables.<name>`）。 */
  assign?: Record<string, ValueTemplate>;
};

export type ProgramNodeReference = {
  programId: ProgramId;
  version: number;
  sourceDigest: Sha256Digest;
};

/** Program / LLM Nodeへ付与する実効capability（requested manifestの部分集合だけを許す）。 */
export type CapabilityGrant = {
  actions?: { actionType: ActionType; resourceType?: string; restriction?: Condition }[];
  llm?: {
    models: string[];
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicroUsd: number;
  };
  maxEffects?: number;
};

export type ProgramNode = NodeBase & {
  type: "program";
  program: ProgramNodeReference;
  input: ValueTemplate;
  capabilities?: CapabilityGrant;
};

export type LlmNode = NodeBase & {
  type: "llm";
  model: string;
  /** 文字列、またはsystem / userを持つobjectへ評価されるテンプレート。 */
  prompt: ValueTemplate;
  maxOutputTokens: number;
  capabilities?: CapabilityGrant;
};

/** v1は`all_active`: 同じexecution scopeのactiveなincoming pathだけを待つ。 */
export type JoinNode = NodeBase & { type: "join" };

export type OutputNode = NodeBase & { type: "output"; value: ValueTemplate };

export type WorkflowNode =
  | TriggerNode
  | ActionNode
  | BranchNode
  | ForEachNode
  | WhileNode
  | TransformNode
  | ProgramNode
  | LlmNode
  | JoinNode
  | OutputNode;

export type WorkflowNodeType = WorkflowNode["type"];

/** control-flow edge。Branchから出るedgeだけが`branch`（case key）を持つ。 */
export type WorkflowEdge = {
  id: string;
  source: NodeId;
  target: NodeId;
  branch?: string;
};

export type RetryPolicy = {
  /** 初回を含む最大試行回数（1 = retryしない）。 */
  maxAttempts: number;
  backoffSeconds: number;
};

export type WorkflowLimits = {
  /** 1 runで生成できるNodeRun数の上限（runaway guard）。 */
  maxNodeRuns?: number;
  /** 同時にin-flightにできる外部作用Node（action / program / llm）の数。 */
  maxParallelEffects?: number;
};

/** publish前の編集可能なWorkflow Definition。 */
export type WorkflowDefinition = {
  id: WorkflowDefinitionId;
  name: string;
  description?: string;
  /** `workflow.input.*`の型付きfield catalog（UIのfield pickerとprojectionが使う）。 */
  inputFields?: FieldDefinition[];
  variables?: JsonObject;
  graph: WorkflowGraph;
  limits?: WorkflowLimits;
};

/** publish済みの不変なWorkflow Version。in-placeで変更せず、変更は新versionとしてpublishする。 */
export type WorkflowVersion = {
  definitionId: WorkflowDefinitionId;
  version: number;
  checksum: Sha256Digest;
  definition: WorkflowDefinition;
  publishedAt: string;
  publishedBy: PrincipalRef;
};

export const WORKFLOW_GLOBAL_LIMITS = {
  maxWhileIterations: 1000,
  maxForEachItems: 1000,
  maxForEachConcurrency: 32,
  maxLoopNesting: 4,
  maxNodeRuns: 5000,
  maxParallelEffects: 32,
  maxNodesPerGraph: 200,
  maxRetryAttempts: 5,
} as const;

export const DEFAULT_WORKFLOW_LIMITS = {
  maxNodeRuns: 1000,
  maxParallelEffects: 8,
} as const;
