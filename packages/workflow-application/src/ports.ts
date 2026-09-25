import type { Result } from "@praha/byethrow";

import type {
  ActionAuthority,
  ActionFingerprint,
  ActionOrigin,
  ActionRequestId,
  OrganizationId,
  PrincipalRef,
} from "@app/approval-core";
import type { JsonValue } from "@app/expression-core";
import type {
  EffectRecord,
  NodeRunId,
  ProgramEffect,
  WaitingReason,
  WorkflowAuditEvent,
  WorkflowDefinition,
  WorkflowDefinitionId,
  WorkflowNode,
  WorkflowRunId,
  WorkflowRunState,
  WorkflowVersion,
} from "@app/workflow-core";

export class WorkflowRepositoryError extends Error {
  override readonly name: string = "WorkflowRepositoryError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** Composite ActionとしてActionRequestから開始された場合の親binding（#158 / #165）。 */
export type ParentActionBinding = {
  actionRequestId: ActionRequestId;
  actionFingerprint: ActionFingerprint;
  idempotencyKey: string;
  /** async executorが返したexecutionRef（= WorkflowRun ID）。 */
  executionRef: string;
};

/**
 * WorkflowRunを開始した主体と権限。child ActionRequestはこのauthorityを起点に
 * Workflow Agent / Node Agentへ委任を狭めて発行する（権限は拡張されない）。
 */
export type WorkflowInvocation = {
  actor: PrincipalRef;
  authority: ActionAuthority;
  origin: ActionOrigin;
  parentAction?: ParentActionBinding;
  parentRunId?: WorkflowRunId;
  parentNodeRunId?: NodeRunId;
  /** 祖先runのWorkflow Definition（root → 親）。Composite recursionの検出に使う。 */
  ancestry?: WorkflowDefinitionId[];
  /**
   * Composite ActionRequestの委任chainから引き継ぐ時間境界（最も厳しいnotBefore / expiresAt）。
   * Workflow Agentへのhopへ付与し、親の委任が失効したら内部のchild Actionも拒否される。
   */
  delegationTimeBounds?: { notBefore?: string; expiresAt?: string };
};

export type WorkflowRunRecord = {
  state: WorkflowRunState;
  revision: number;
  depth: number;
  invocation: WorkflowInvocation;
  /** 次に進める時刻のhint（timer / backoff / poll）。 */
  wakeAt?: string;
  /** 終端結果を親（Composite ActionのActionRequest等）へ届け終えたか。 */
  completionDelivered: boolean;
};

export type WorkflowVersionSaveResult = { type: "created" } | { type: "existing" };

export interface WorkflowVersionRepository {
  /** insert-only。同じ(definitionId, version)に別checksumを保存しようとした場合はconflict error。 */
  save(input: {
    organizationId: OrganizationId;
    version: WorkflowVersion;
  }): Result.ResultAsync<WorkflowVersionSaveResult, WorkflowRepositoryError>;
  load(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
    version: number;
  }): Result.ResultAsync<WorkflowVersion | null, WorkflowRepositoryError>;
  latest(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowVersion | null, WorkflowRepositoryError>;
  list(input: {
    organizationId: OrganizationId;
    definitionId?: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowVersion[], WorkflowRepositoryError>;
}

export type WorkflowDraftRecord = {
  definition: WorkflowDefinition;
  revision: number;
  updatedAt: string;
};

export interface WorkflowDraftRepository {
  save(input: {
    organizationId: OrganizationId;
    definition: WorkflowDefinition;
    expectedRevision: number | null;
    updatedAt: string;
  }): Result.ResultAsync<
    { type: "saved"; revision: number } | { type: "conflict" },
    WorkflowRepositoryError
  >;
  load(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowDraftRecord | null, WorkflowRepositoryError>;
  list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<WorkflowDraftRecord[], WorkflowRepositoryError>;
}

export type WorkflowRunSaveResult = { type: "saved"; revision: number } | { type: "conflict" };

export interface WorkflowRunRepository {
  /** runIdで冪等。既に存在すれば既存recordを返す。 */
  create(input: {
    record: WorkflowRunRecord;
    events: readonly WorkflowAuditEvent[];
  }): Result.ResultAsync<
    { type: "created" } | { type: "existing"; record: WorkflowRunRecord },
    WorkflowRepositoryError
  >;
  load(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowRunRecord | null, WorkflowRepositoryError>;
  /** revisionでcompare-and-setし、同じ遷移の監査イベントと原子的に保存する。 */
  save(input: {
    record: WorkflowRunRecord;
    expectedRevision: number;
    events: readonly WorkflowAuditEvent[];
  }): Result.ResultAsync<WorkflowRunSaveResult, WorkflowRepositoryError>;
  findByParentAction(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<WorkflowRunRecord | null, WorkflowRepositoryError>;
  /** 非終端でwakeAtが到来した（または終端済みで親へ未通知の）run。 */
  listDue(input: {
    now: string;
    limit: number;
  }): Result.ResultAsync<
    { organizationId: OrganizationId; runId: WorkflowRunId }[],
    WorkflowRepositoryError
  >;
  list(input: {
    organizationId: OrganizationId;
    limit: number;
  }): Result.ResultAsync<WorkflowRunRecord[], WorkflowRepositoryError>;
  listEvents(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowAuditEvent[], WorkflowRepositoryError>;
}

export class EffectHandlerError extends Error {
  override readonly name: string = "EffectHandlerError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** 外部作用の配送 / pollの結果。 */
export type EffectOutcomeReport =
  | { type: "completed"; output: JsonValue; reference?: string }
  | { type: "failed"; code: string; message: string; retriable?: boolean; reference?: string }
  | { type: "in_flight"; waitingReason: WaitingReason; reference?: string; wakeAt?: string }
  | { type: "yielded"; state: JsonValue; effect: ProgramEffect };

export type EffectContext = {
  run: WorkflowRunRecord;
  version: WorkflowVersion;
  effect: EffectRecord;
  /** 作用を要求したNode（Program yieldの場合はProgram Node）。 */
  node: WorkflowNode;
  now: string;
};

/**
 * 作用の種類ごとの実行adapter。dispatchはeffect IDで冪等でなければならない
 * （crash / CAS競合で同じ作用が再配送されうる）。
 */
export interface EffectHandler {
  dispatch(context: EffectContext): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError>;
  /** in-flight作用の現在状態（例: child ActionRequestの状態）。 */
  poll?(context: EffectContext): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError>;
  /** cancelされたin-flight作用をchildへ伝播する（冪等）。 */
  cancel?(context: EffectContext): Result.ResultAsync<void, EffectHandlerError>;
}

export type EffectHandlers = Partial<Record<EffectRecord["request"]["kind"], EffectHandler>>;

/** WorkflowRunの終端を親へ届けるport（Composite Actionの親ActionRequest完了等）。冪等であること。 */
export interface WorkflowCompletionListener {
  completed(record: WorkflowRunRecord): Result.ResultAsync<void, EffectHandlerError>;
}

/** WorkflowRun開始のadmission（tenant quota等, #161）。 */
export interface WorkflowAdmissionController {
  admitRun(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
    runId: WorkflowRunId;
    depth: number;
  }): Result.ResultAsync<
    { type: "admitted" } | { type: "denied"; code: string; message: string },
    EffectHandlerError
  >;
  releaseRun?(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<void, EffectHandlerError>;
}

export interface Clock {
  now(): string;
}
