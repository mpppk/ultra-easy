import { Result } from "@praha/byethrow";

import { parseBrand } from "@app/approval-core";
import type { ActionRequestId, OrganizationId } from "@app/approval-core";
import { WorkflowRepositoryError } from "@app/workflow-application";
import type {
  WorkflowDraftRecord,
  WorkflowDraftRepository,
  WorkflowInvocation,
  WorkflowRunRecord,
  WorkflowRunRepository,
  WorkflowRunSaveResult,
  WorkflowVersionRepository,
  WorkflowVersionSaveResult,
} from "@app/workflow-application";
import { parseWorkflowId } from "@app/workflow-core";
import type {
  WorkflowAuditEvent,
  WorkflowDefinition,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkflowRunState,
  WorkflowVersion,
} from "@app/workflow-core";

import { allRows, changes, firstRow, parseJson, runBatch } from "./d1.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./d1.ts";

type VersionRow = { checksum: string; version_json: string };

type DraftRow = { draft_json: string; revision: number; updated_at: string };

type RunRow = {
  state_json: string;
  invocation_json: string;
  revision: number;
  depth: number;
  wake_at: string | null;
  completion_delivered: number;
};

type EventRow = { event_json: string };

type RunKeyRow = { organization_id: string; run_id: string };

function parseOrganizationId(
  value: unknown,
): Result.Result<OrganizationId, WorkflowRepositoryError> {
  const parsed = parseBrand("OrganizationId", value);
  return Result.isFailure(parsed)
    ? Result.fail(
        new WorkflowRepositoryError("workflow_stored_id_invalid", false, parsed.error.message),
      )
    : parsed;
}

function conflict(message: string): WorkflowRepositoryError {
  return new WorkflowRepositoryError("workflow_version_conflict", false, message);
}

export class D1WorkflowVersionRepository implements WorkflowVersionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(input: {
    organizationId: OrganizationId;
    version: WorkflowVersion;
  }): Result.ResultAsync<WorkflowVersionSaveResult, WorkflowRepositoryError> {
    const { version } = input;
    const inserted = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_versions
               (organization_id, definition_id, version, checksum, version_json, published_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(input.organizationId),
            String(version.definitionId),
            version.version,
            String(version.checksum),
            JSON.stringify(version),
            version.publishedAt,
          ),
      ],
    });
    if (Result.isFailure(inserted)) return inserted;
    if (changes(inserted.value[0]) === 1) return Result.succeed({ type: "created" });
    const existing = await firstRow<VersionRow>(
      this.db
        .prepare(
          "SELECT checksum, version_json FROM workflow_versions WHERE organization_id = ? AND definition_id = ? AND version = ?",
        )
        .bind(String(input.organizationId), String(version.definitionId), version.version),
    );
    if (Result.isFailure(existing)) return existing;
    if (existing.value?.checksum !== String(version.checksum)) {
      return Result.fail(conflict("同じversionに別のdefinitionは保存できません（immutable）"));
    }
    return Result.succeed({ type: "existing" });
  }

  async load(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
    version: number;
  }): Result.ResultAsync<WorkflowVersion | null, WorkflowRepositoryError> {
    const row = await firstRow<VersionRow>(
      this.db
        .prepare(
          "SELECT checksum, version_json FROM workflow_versions WHERE organization_id = ? AND definition_id = ? AND version = ?",
        )
        .bind(String(input.organizationId), String(input.definitionId), input.version),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return parseJson<WorkflowVersion>(row.value.version_json);
  }

  async latest(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowVersion | null, WorkflowRepositoryError> {
    const row = await firstRow<VersionRow>(
      this.db
        .prepare(
          "SELECT checksum, version_json FROM workflow_versions WHERE organization_id = ? AND definition_id = ? ORDER BY version DESC LIMIT 1",
        )
        .bind(String(input.organizationId), String(input.definitionId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return parseJson<WorkflowVersion>(row.value.version_json);
  }

  async list(input: {
    organizationId: OrganizationId;
    definitionId?: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowVersion[], WorkflowRepositoryError> {
    const statement =
      input.definitionId === undefined
        ? this.db
            .prepare(
              "SELECT checksum, version_json FROM workflow_versions WHERE organization_id = ? ORDER BY definition_id, version",
            )
            .bind(String(input.organizationId))
        : this.db
            .prepare(
              "SELECT checksum, version_json FROM workflow_versions WHERE organization_id = ? AND definition_id = ? ORDER BY version",
            )
            .bind(String(input.organizationId), String(input.definitionId));
    const rows = await allRows<VersionRow>(statement);
    if (Result.isFailure(rows)) return rows;
    const versions: WorkflowVersion[] = [];
    for (const row of rows.value) {
      const parsed = parseJson<WorkflowVersion>(row.version_json);
      if (Result.isFailure(parsed)) return parsed;
      versions.push(parsed.value);
    }
    return Result.succeed(versions);
  }
}

export class D1WorkflowDraftRepository implements WorkflowDraftRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(input: {
    organizationId: OrganizationId;
    definition: WorkflowDefinition;
    expectedRevision: number | null;
    updatedAt: string;
  }): Result.ResultAsync<
    { type: "saved"; revision: number } | { type: "conflict" },
    WorkflowRepositoryError
  > {
    const json = JSON.stringify(input.definition);
    const statement =
      input.expectedRevision === null
        ? this.db
            .prepare(
              `INSERT OR IGNORE INTO workflow_definitions
                 (organization_id, definition_id, draft_json, revision, updated_at)
               VALUES (?, ?, ?, 1, ?)`,
            )
            .bind(String(input.organizationId), String(input.definition.id), json, input.updatedAt)
        : this.db
            .prepare(
              `UPDATE workflow_definitions SET draft_json = ?, revision = revision + 1, updated_at = ?
               WHERE organization_id = ? AND definition_id = ? AND revision = ?`,
            )
            .bind(
              json,
              input.updatedAt,
              String(input.organizationId),
              String(input.definition.id),
              input.expectedRevision,
            );
    const saved = await runBatch({ db: this.db, statements: [statement] });
    if (Result.isFailure(saved)) return saved;
    if (changes(saved.value[0]) !== 1) return Result.succeed({ type: "conflict" });
    return Result.succeed({ type: "saved", revision: (input.expectedRevision ?? 0) + 1 });
  }

  async load(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowDraftRecord | null, WorkflowRepositoryError> {
    const row = await firstRow<DraftRow>(
      this.db
        .prepare(
          "SELECT draft_json, revision, updated_at FROM workflow_definitions WHERE organization_id = ? AND definition_id = ?",
        )
        .bind(String(input.organizationId), String(input.definitionId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return this.toRecord(row.value);
  }

  async list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<WorkflowDraftRecord[], WorkflowRepositoryError> {
    const rows = await allRows<DraftRow>(
      this.db
        .prepare(
          "SELECT draft_json, revision, updated_at FROM workflow_definitions WHERE organization_id = ? ORDER BY definition_id",
        )
        .bind(String(input.organizationId)),
    );
    if (Result.isFailure(rows)) return rows;
    const records: WorkflowDraftRecord[] = [];
    for (const row of rows.value) {
      const record = this.toRecord(row);
      if (Result.isFailure(record)) return record;
      records.push(record.value);
    }
    return Result.succeed(records);
  }

  private toRecord(row: DraftRow): Result.Result<WorkflowDraftRecord, WorkflowRepositoryError> {
    const definition = parseJson<WorkflowDefinition>(row.draft_json);
    if (Result.isFailure(definition)) return definition;
    return Result.succeed({
      definition: definition.value,
      revision: row.revision,
      updatedAt: row.updated_at,
    });
  }
}

const RUN_COLUMNS = "state_json, invocation_json, revision, depth, wake_at, completion_delivered";

/**
 * D1のWorkflowRun store。revisionでCASし、監査イベントは同じbatchで
 * 「このwriterの更新が確定した場合だけ」insertする（last_writer token）。
 */
export class D1WorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  private eventStatements(
    events: readonly WorkflowAuditEvent[],
    writer: string,
  ): D1PreparedStatementLike[] {
    return events.map((event) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO workflow_events
             (organization_id, run_id, event_key, event_type, node_run_id, effect_id, occurred_at, event_json)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM workflow_runs WHERE organization_id = ? AND run_id = ? AND last_writer = ?
           )`,
        )
        .bind(
          String(event.organizationId),
          String(event.runId),
          event.eventKey,
          event.type,
          event.nodeRunId ?? null,
          event.effectId ?? null,
          event.occurredAt,
          JSON.stringify(event),
          String(event.organizationId),
          String(event.runId),
          writer,
        ),
    );
  }

  private toRecord(row: RunRow): Result.Result<WorkflowRunRecord, WorkflowRepositoryError> {
    const state = parseJson<WorkflowRunState>(row.state_json);
    if (Result.isFailure(state)) return state;
    const invocation = parseJson<WorkflowInvocation>(row.invocation_json);
    if (Result.isFailure(invocation)) return invocation;
    return Result.succeed({
      state: state.value,
      invocation: invocation.value,
      revision: row.revision,
      depth: row.depth,
      completionDelivered: row.completion_delivered === 1,
      ...(row.wake_at !== null ? { wakeAt: row.wake_at } : {}),
    });
  }

  async create(input: {
    record: WorkflowRunRecord;
    events: readonly WorkflowAuditEvent[];
  }): Result.ResultAsync<
    { type: "created" } | { type: "existing"; record: WorkflowRunRecord },
    WorkflowRepositoryError
  > {
    const { record } = input;
    const { state } = record;
    const writer = globalThis.crypto.randomUUID();
    const created = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_runs
               (organization_id, run_id, definition_id, version, checksum, status, depth,
                parent_action_request_id, parent_run_id, invocation_json, state_json, revision,
                last_writer, wake_at, completion_delivered, created_at, updated_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(state.organizationId),
            String(state.runId),
            String(state.definitionId),
            state.version,
            String(state.checksum),
            state.status,
            record.depth,
            record.invocation.parentAction
              ? String(record.invocation.parentAction.actionRequestId)
              : null,
            record.invocation.parentRunId ? String(record.invocation.parentRunId) : null,
            JSON.stringify(record.invocation),
            JSON.stringify(state),
            writer,
            record.wakeAt ?? null,
            record.completionDelivered ? 1 : 0,
            state.createdAt,
            state.updatedAt,
            state.completedAt ?? null,
          ),
        ...this.eventStatements(input.events, writer),
      ],
    });
    if (Result.isFailure(created)) return created;
    if (changes(created.value[0]) === 1) return Result.succeed({ type: "created" });
    const existing = await this.load({ organizationId: state.organizationId, runId: state.runId });
    if (Result.isFailure(existing)) return existing;
    if (existing.value) return Result.succeed({ type: "existing", record: existing.value });
    const parent = record.invocation.parentAction;
    if (parent) {
      const byParent = await this.findByParentAction({
        organizationId: state.organizationId,
        actionRequestId: parent.actionRequestId,
      });
      if (Result.isFailure(byParent)) return byParent;
      if (byParent.value) return Result.succeed({ type: "existing", record: byParent.value });
    }
    return Result.fail(
      new WorkflowRepositoryError(
        "workflow_run_create_failed",
        true,
        "WorkflowRunを作成できませんでした",
      ),
    );
  }

  async load(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowRunRecord | null, WorkflowRepositoryError> {
    const row = await firstRow<RunRow>(
      this.db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE organization_id = ? AND run_id = ?`,
        )
        .bind(String(input.organizationId), String(input.runId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return this.toRecord(row.value);
  }

  async save(input: {
    record: WorkflowRunRecord;
    expectedRevision: number;
    events: readonly WorkflowAuditEvent[];
  }): Result.ResultAsync<WorkflowRunSaveResult, WorkflowRepositoryError> {
    const { record } = input;
    const { state } = record;
    const writer = globalThis.crypto.randomUUID();
    const saved = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `UPDATE workflow_runs
               SET status = ?, state_json = ?, revision = revision + 1, last_writer = ?, wake_at = ?,
                   completion_delivered = ?, updated_at = ?, completed_at = ?
             WHERE organization_id = ? AND run_id = ? AND revision = ?`,
          )
          .bind(
            state.status,
            JSON.stringify(state),
            writer,
            record.wakeAt ?? null,
            record.completionDelivered ? 1 : 0,
            state.updatedAt,
            state.completedAt ?? null,
            String(state.organizationId),
            String(state.runId),
            input.expectedRevision,
          ),
        ...this.eventStatements(input.events, writer),
      ],
    });
    if (Result.isFailure(saved)) return saved;
    if (changes(saved.value[0]) !== 1) return Result.succeed({ type: "conflict" });
    return Result.succeed({ type: "saved", revision: input.expectedRevision + 1 });
  }

  async findByParentAction(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<WorkflowRunRecord | null, WorkflowRepositoryError> {
    const row = await firstRow<RunRow>(
      this.db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE organization_id = ? AND parent_action_request_id = ?`,
        )
        .bind(String(input.organizationId), String(input.actionRequestId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return this.toRecord(row.value);
  }

  async listDue(input: {
    now: string;
    limit: number;
  }): Result.ResultAsync<
    { organizationId: OrganizationId; runId: WorkflowRunId }[],
    WorkflowRepositoryError
  > {
    const rows = await allRows<RunKeyRow>(
      this.db
        .prepare(
          `SELECT organization_id, run_id FROM workflow_runs
           WHERE wake_at IS NOT NULL AND wake_at <= ?
             AND (status IN ('running', 'waiting') OR completion_delivered = 0)
           ORDER BY wake_at LIMIT ?`,
        )
        .bind(input.now, input.limit),
    );
    if (Result.isFailure(rows)) return rows;
    const keys: { organizationId: OrganizationId; runId: WorkflowRunId }[] = [];
    for (const row of rows.value) {
      const runId = parseWorkflowId("WorkflowRunId", row.run_id);
      if (Result.isFailure(runId)) {
        return Result.fail(
          new WorkflowRepositoryError("workflow_stored_id_invalid", false, runId.error.message),
        );
      }
      // organization_idは自分たちが書いた値。approval-coreのsmart constructorで検証する。
      const organizationId = parseOrganizationId(row.organization_id);
      if (Result.isFailure(organizationId)) return organizationId;
      keys.push({ organizationId: organizationId.value, runId: runId.value });
    }
    return Result.succeed(keys);
  }

  async list(input: {
    organizationId: OrganizationId;
    limit: number;
  }): Result.ResultAsync<WorkflowRunRecord[], WorkflowRepositoryError> {
    const rows = await allRows<RunRow>(
      this.db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(String(input.organizationId), input.limit),
    );
    if (Result.isFailure(rows)) return rows;
    const records: WorkflowRunRecord[] = [];
    for (const row of rows.value) {
      const record = this.toRecord(row);
      if (Result.isFailure(record)) return record;
      records.push(record.value);
    }
    return Result.succeed(records);
  }

  async listEvents(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowAuditEvent[], WorkflowRepositoryError> {
    const rows = await allRows<EventRow>(
      this.db
        .prepare(
          "SELECT event_json FROM workflow_events WHERE organization_id = ? AND run_id = ? ORDER BY sequence",
        )
        .bind(String(input.organizationId), String(input.runId)),
    );
    if (Result.isFailure(rows)) return rows;
    const events: WorkflowAuditEvent[] = [];
    for (const row of rows.value) {
      const event = parseJson<WorkflowAuditEvent>(row.event_json);
      if (Result.isFailure(event)) return event;
      events.push(event.value);
    }
    return Result.succeed(events);
  }
}
