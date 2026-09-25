import { Result } from "@praha/byethrow";

import { parseBrand } from "@app/approval-core";
import type {
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  OrganizationId,
  PrincipalRef,
} from "@app/approval-core";
import { EffectHandlerError, WorkflowRepositoryError } from "@app/workflow-application";
import type {
  ActionCatalogPublisher,
  ChildActionCorrelation,
  ChildActionCorrelationRepository,
  WorkflowActionBinding,
  WorkflowActionBindingRepository,
} from "@app/workflow-application";
import { parseWorkflowId } from "@app/workflow-core";
import type { WorkflowDefinitionId, WorkflowRunId } from "@app/workflow-core";

import { allRows, changes, firstRow, parseJson, runBatch } from "./d1.ts";
import type { D1DatabaseLike } from "./d1.ts";

type BindingRow = {
  organization_id: string;
  action_definition_key: string;
  action_definition_version: number;
  action_type: string;
  workflow_definition_id: string;
  workflow_version: number;
  workflow_checksum: string;
  created_at: string;
};

type CorrelationRow = {
  organization_id: string;
  child_action_request_id: string;
  run_id: string;
  node_run_id: string;
  effect_id: string;
  parent_action_request_id: string | null;
  depth: number;
  ancestry_json: string;
  action_type: string;
  created_at: string;
};

function invalid(message: string): WorkflowRepositoryError {
  return new WorkflowRepositoryError("workflow_stored_value_invalid", false, message);
}

function bindingFromRow(
  row: BindingRow,
): Result.Result<WorkflowActionBinding, WorkflowRepositoryError> {
  const organizationId = parseBrand("OrganizationId", row.organization_id);
  const key = parseBrand("ActionDefinitionKey", row.action_definition_key);
  const actionType = parseBrand("ActionType", row.action_type);
  const checksum = parseBrand("Sha256Digest", row.workflow_checksum);
  const definitionId = parseWorkflowId("WorkflowDefinitionId", row.workflow_definition_id);
  if (
    Result.isFailure(organizationId) ||
    Result.isFailure(key) ||
    Result.isFailure(actionType) ||
    Result.isFailure(checksum) ||
    Result.isFailure(definitionId)
  ) {
    return Result.fail(invalid("保存済みWorkflowActionBindingが不正です"));
  }
  return Result.succeed({
    organizationId: organizationId.value,
    actionDefinitionKey: key.value,
    actionDefinitionVersion: row.action_definition_version,
    actionType: actionType.value,
    workflowDefinitionId: definitionId.value,
    workflowVersion: row.workflow_version,
    workflowChecksum: checksum.value,
    createdAt: row.created_at,
  });
}

const BINDING_COLUMNS = `organization_id, action_definition_key, action_definition_version, action_type,
  workflow_definition_id, workflow_version, workflow_checksum, created_at`;

export class D1WorkflowActionBindingRepository implements WorkflowActionBindingRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(
    binding: WorkflowActionBinding,
  ): Result.ResultAsync<{ type: "created" | "existing" }, WorkflowRepositoryError> {
    const inserted = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_action_bindings (${BINDING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(binding.organizationId),
            String(binding.actionDefinitionKey),
            binding.actionDefinitionVersion,
            String(binding.actionType),
            String(binding.workflowDefinitionId),
            binding.workflowVersion,
            String(binding.workflowChecksum),
            binding.createdAt,
          ),
      ],
    });
    if (Result.isFailure(inserted)) return inserted;
    if (changes(inserted.value[0]) === 1) return Result.succeed({ type: "created" });
    const existing = await this.load(binding);
    if (Result.isFailure(existing)) return existing;
    const same =
      existing.value !== null &&
      String(existing.value.workflowDefinitionId) === String(binding.workflowDefinitionId) &&
      existing.value.workflowVersion === binding.workflowVersion &&
      String(existing.value.workflowChecksum) === String(binding.workflowChecksum);
    return same
      ? Result.succeed({ type: "existing" })
      : Result.fail(
          new WorkflowRepositoryError(
            "workflow_action_binding_conflict",
            false,
            "ActionDefinition versionのWorkflow bindingは差し替えられません（immutable）",
          ),
        );
  }

  async load(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }): Result.ResultAsync<WorkflowActionBinding | null, WorkflowRepositoryError> {
    const row = await firstRow<BindingRow>(
      this.db
        .prepare(
          `SELECT ${BINDING_COLUMNS} FROM workflow_action_bindings
            WHERE organization_id = ? AND action_definition_key = ? AND action_definition_version = ?`,
        )
        .bind(
          String(input.organizationId),
          String(input.actionDefinitionKey),
          input.actionDefinitionVersion,
        ),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? bindingFromRow(row.value) : Result.succeed(null);
  }

  private async listWhere(
    sql: string,
    values: unknown[],
  ): Result.ResultAsync<WorkflowActionBinding[], WorkflowRepositoryError> {
    const rows = await allRows<BindingRow>(this.db.prepare(sql).bind(...values));
    if (Result.isFailure(rows)) return rows;
    const bindings: WorkflowActionBinding[] = [];
    for (const row of rows.value) {
      const binding = bindingFromRow(row);
      if (Result.isFailure(binding)) return binding;
      bindings.push(binding.value);
    }
    return Result.succeed(bindings);
  }

  async listForWorkflow(input: {
    organizationId: OrganizationId;
    workflowDefinitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowActionBinding[], WorkflowRepositoryError> {
    return this.listWhere(
      `SELECT ${BINDING_COLUMNS} FROM workflow_action_bindings
        WHERE organization_id = ? AND workflow_definition_id = ? ORDER BY action_definition_version`,
      [String(input.organizationId), String(input.workflowDefinitionId)],
    );
  }

  async list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<WorkflowActionBinding[], WorkflowRepositoryError> {
    return this.listWhere(
      `SELECT ${BINDING_COLUMNS} FROM workflow_action_bindings
        WHERE organization_id = ? ORDER BY action_definition_key, action_definition_version`,
      [String(input.organizationId)],
    );
  }
}

function correlationFromRow(
  row: CorrelationRow,
): Result.Result<ChildActionCorrelation, WorkflowRepositoryError> {
  const organizationId = parseBrand("OrganizationId", row.organization_id);
  const child = parseBrand("ActionRequestId", row.child_action_request_id);
  const actionType = parseBrand("ActionType", row.action_type);
  const runId = parseWorkflowId("WorkflowRunId", row.run_id);
  const nodeRunId = parseWorkflowId("NodeRunId", row.node_run_id);
  const effectId = parseWorkflowId("EffectId", row.effect_id);
  const parent =
    row.parent_action_request_id === null
      ? null
      : parseBrand("ActionRequestId", row.parent_action_request_id);
  const ancestry = parseJson<string[]>(row.ancestry_json);
  if (
    Result.isFailure(organizationId) ||
    Result.isFailure(child) ||
    Result.isFailure(actionType) ||
    Result.isFailure(runId) ||
    Result.isFailure(nodeRunId) ||
    Result.isFailure(effectId) ||
    (parent !== null && Result.isFailure(parent)) ||
    Result.isFailure(ancestry)
  ) {
    return Result.fail(invalid("保存済みchild Action相関が不正です"));
  }
  const ancestryIds: WorkflowDefinitionId[] = [];
  for (const value of ancestry.value) {
    const parsed = parseWorkflowId("WorkflowDefinitionId", value);
    if (Result.isFailure(parsed)) return Result.fail(invalid("保存済みancestryが不正です"));
    ancestryIds.push(parsed.value);
  }
  return Result.succeed({
    organizationId: organizationId.value,
    childActionRequestId: child.value,
    runId: runId.value,
    nodeRunId: nodeRunId.value,
    effectId: effectId.value,
    ...(parent !== null && Result.isSuccess(parent) ? { parentActionRequestId: parent.value } : {}),
    depth: row.depth,
    ancestry: ancestryIds,
    actionType: actionType.value,
    createdAt: row.created_at,
  });
}

const CORRELATION_COLUMNS = `organization_id, child_action_request_id, run_id, node_run_id, effect_id,
  parent_action_request_id, depth, ancestry_json, action_type, created_at`;

export class D1ChildActionCorrelationRepository implements ChildActionCorrelationRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async record(
    correlation: ChildActionCorrelation,
  ): Result.ResultAsync<void, WorkflowRepositoryError> {
    const saved = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_child_actions (${CORRELATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(correlation.organizationId),
            String(correlation.childActionRequestId),
            String(correlation.runId),
            String(correlation.nodeRunId),
            String(correlation.effectId),
            correlation.parentActionRequestId ? String(correlation.parentActionRequestId) : null,
            correlation.depth,
            JSON.stringify(correlation.ancestry.map(String)),
            String(correlation.actionType),
            correlation.createdAt,
          ),
      ],
    });
    if (Result.isFailure(saved)) return saved;
    return Result.succeed(undefined);
  }

  async findByChild(input: {
    organizationId: OrganizationId;
    childActionRequestId: ActionRequestId;
  }): Result.ResultAsync<ChildActionCorrelation | null, WorkflowRepositoryError> {
    const row = await firstRow<CorrelationRow>(
      this.db
        .prepare(
          `SELECT ${CORRELATION_COLUMNS} FROM workflow_child_actions WHERE organization_id = ? AND child_action_request_id = ?`,
        )
        .bind(String(input.organizationId), String(input.childActionRequestId)),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? correlationFromRow(row.value) : Result.succeed(null);
  }

  async listForRun(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<ChildActionCorrelation[], WorkflowRepositoryError> {
    const rows = await allRows<CorrelationRow>(
      this.db
        .prepare(
          `SELECT ${CORRELATION_COLUMNS} FROM workflow_child_actions
            WHERE organization_id = ? AND run_id = ? ORDER BY created_at, child_action_request_id`,
        )
        .bind(String(input.organizationId), String(input.runId)),
    );
    if (Result.isFailure(rows)) return rows;
    const correlations: ChildActionCorrelation[] = [];
    for (const row of rows.value) {
      const correlation = correlationFromRow(row);
      if (Result.isFailure(correlation)) return correlation;
      correlations.push(correlation.value);
    }
    return Result.succeed(correlations);
  }
}

/**
 * Composite ActionのActionDefinitionを`published_action_definitions`へ公開する。
 * primitive Actionと同じtable / resolver（`D1PublishedActionDefinitionResolver`）から解決される。
 */
export class D1ActionCatalogPublisher implements ActionCatalogPublisher {
  constructor(private readonly db: D1DatabaseLike) {}

  async latestVersion(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
  }): Result.ResultAsync<number | null, EffectHandlerError> {
    const row = await firstRow<{ version: number | null }>(
      this.db
        .prepare(
          "SELECT MAX(version) AS version FROM published_action_definitions WHERE organization_id = ? AND definition_key = ?",
        )
        .bind(String(input.organizationId), String(input.actionDefinitionKey)),
    );
    if (Result.isFailure(row)) {
      return Result.fail(
        new EffectHandlerError(row.error.code, row.error.retriable, row.error.message),
      );
    }
    return Result.succeed(row.value?.version ?? null);
  }

  async publish(input: {
    organizationId: OrganizationId;
    definition: ActionDefinition;
    publishedBy: PrincipalRef;
    publishedAt: string;
  }): Result.ResultAsync<void, EffectHandlerError> {
    const { definition } = input;
    const saved = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO published_action_definitions
               (organization_id, definition_key, version, action_type, definition_json, actor_json,
                source_action_request_id, published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(input.organizationId),
            String(definition.key),
            definition.version,
            String(definition.actionType),
            JSON.stringify(definition),
            JSON.stringify(input.publishedBy),
            `workflow-publish:${String(definition.key)}@${definition.version}`,
            input.publishedAt,
          ),
      ],
    });
    if (Result.isFailure(saved)) {
      return Result.fail(
        new EffectHandlerError(saved.error.code, saved.error.retriable, saved.error.message),
      );
    }
    return Result.succeed(undefined);
  }
}
