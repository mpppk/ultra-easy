import type { Result } from "@praha/byethrow";

import type {
  ActionAuthority,
  ActionDefinition,
  ActionDefinitionKey,
  ActionFingerprint,
  ActionOrigin,
  ActionRequestId,
  ActionType,
  OrganizationId,
  PrincipalRef,
  Sha256Digest,
} from "@app/approval-core";
import type { JsonObject } from "@app/expression-core";
import type { EffectId, NodeRunId, WorkflowDefinitionId, WorkflowRunId } from "@app/workflow-core";

import type { EffectHandlerError, WorkflowRepositoryError } from "../ports.ts";

/**
 * Composite ActionのActionDefinition version → WorkflowVersionの対応（#158）。
 * 同じ(actionDefinitionKey, actionDefinitionVersion)を別のWorkflowVersionへ差し替えてはならない
 * （repositoryはinsert-only、DBはUPDATE / DELETEをtriggerで禁止する）。
 */
export type WorkflowActionBinding = {
  organizationId: OrganizationId;
  actionDefinitionKey: ActionDefinitionKey;
  actionDefinitionVersion: number;
  actionType: ActionType;
  workflowDefinitionId: WorkflowDefinitionId;
  workflowVersion: number;
  workflowChecksum: Sha256Digest;
  createdAt: string;
};

export interface WorkflowActionBindingRepository {
  save(
    binding: WorkflowActionBinding,
  ): Result.ResultAsync<{ type: "created" | "existing" }, WorkflowRepositoryError>;
  load(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }): Result.ResultAsync<WorkflowActionBinding | null, WorkflowRepositoryError>;
  listForWorkflow(input: {
    organizationId: OrganizationId;
    workflowDefinitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowActionBinding[], WorkflowRepositoryError>;
  list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<WorkflowActionBinding[], WorkflowRepositoryError>;
}

/** child ActionRequestと、それを発行したWorkflowRun / NodeRun / Effectの相関（audit / nesting）。 */
export type ChildActionCorrelation = {
  organizationId: OrganizationId;
  childActionRequestId: ActionRequestId;
  runId: WorkflowRunId;
  nodeRunId: NodeRunId;
  effectId: EffectId;
  /** 親WorkflowRunを開始したComposite ActionのActionRequest（あれば）。 */
  parentActionRequestId?: ActionRequestId;
  /** 親WorkflowRunのnest深さ。 */
  depth: number;
  /** recursion検出用: 親runまでに開始されたWorkflow Definitionの列（root → 親）。 */
  ancestry: WorkflowDefinitionId[];
  actionType: ActionType;
  createdAt: string;
};

export interface ChildActionCorrelationRepository {
  record(correlation: ChildActionCorrelation): Result.ResultAsync<void, WorkflowRepositoryError>;
  findByChild(input: {
    organizationId: OrganizationId;
    childActionRequestId: ActionRequestId;
  }): Result.ResultAsync<ChildActionCorrelation | null, WorkflowRepositoryError>;
  listForRun(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<ChildActionCorrelation[], WorkflowRepositoryError>;
}

/** Action CatalogへComposite ActionのActionDefinitionを公開するport。 */
export interface ActionCatalogPublisher {
  latestVersion(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
  }): Result.ResultAsync<number | null, EffectHandlerError>;
  publish(input: {
    organizationId: OrganizationId;
    definition: ActionDefinition;
    publishedBy: PrincipalRef;
    publishedAt: string;
  }): Result.ResultAsync<void, EffectHandlerError>;
}

/** Composite ActionのActionRequestについて、prepare時に固定されたactor / authority / originを返す。 */
export type ParentActionContext = {
  actor: PrincipalRef;
  authority: ActionAuthority;
  origin: ActionOrigin;
  organizationSettings: JsonObject;
  attributes: JsonObject;
};

export interface ParentActionContextResolver {
  resolve(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    actionFingerprint: ActionFingerprint;
  }): Result.ResultAsync<ParentActionContext, EffectHandlerError>;
}

/** WorkflowRunを進めるdriver（in-process advance / Cloudflare runner起動）。best effort。 */
export interface WorkflowRunScheduler {
  schedule(input: { organizationId: OrganizationId; runId: WorkflowRunId }): Promise<void>;
}
