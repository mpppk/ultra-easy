import { Result } from "@praha/byethrow";

import type { ActionRequestId, OrganizationId } from "@app/approval-core";
import { WorkflowRepositoryError } from "@app/workflow-application";
import type {
  WorkflowDraftRecord,
  WorkflowDraftRepository,
  WorkflowRunRecord,
  WorkflowRunRepository,
  WorkflowRunSaveResult,
  WorkflowVersionRepository,
  WorkflowVersionSaveResult,
} from "@app/workflow-application";
import { isTerminalWorkflowRunStatus } from "@app/workflow-core";
import type {
  WorkflowAuditEvent,
  WorkflowDefinition,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkflowVersion,
} from "@app/workflow-core";

function key(...parts: unknown[]): string {
  return JSON.stringify(parts.map(String));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryWorkflowVersionRepository implements WorkflowVersionRepository {
  private readonly versions = new Map<string, WorkflowVersion>();

  async save(input: {
    organizationId: OrganizationId;
    version: WorkflowVersion;
  }): Result.ResultAsync<WorkflowVersionSaveResult, WorkflowRepositoryError> {
    const id = key(input.organizationId, input.version.definitionId, input.version.version);
    const existing = this.versions.get(id);
    if (existing) {
      if (String(existing.checksum) !== String(input.version.checksum)) {
        return Result.fail(
          new WorkflowRepositoryError(
            "workflow_version_conflict",
            false,
            "同じversionに別のdefinitionは保存できません（immutable）",
          ),
        );
      }
      return Result.succeed({ type: "existing" });
    }
    this.versions.set(id, clone(input.version));
    return Result.succeed({ type: "created" });
  }

  async load(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
    version: number;
  }): Result.ResultAsync<WorkflowVersion | null, WorkflowRepositoryError> {
    const found = this.versions.get(key(input.organizationId, input.definitionId, input.version));
    return Result.succeed(found ? clone(found) : null);
  }

  async latest(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowVersion | null, WorkflowRepositoryError> {
    const listed = await this.list(input);
    if (Result.isFailure(listed)) return listed;
    return Result.succeed(listed.value.at(-1) ?? null);
  }

  async list(input: {
    organizationId: OrganizationId;
    definitionId?: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowVersion[], WorkflowRepositoryError> {
    const prefix = String(input.organizationId);
    return Result.succeed(
      [...this.versions.entries()]
        .filter(([id, version]) => {
          const [organizationId] = JSON.parse(id) as string[];
          return (
            organizationId === prefix &&
            (input.definitionId === undefined ||
              String(version.definitionId) === String(input.definitionId))
          );
        })
        .map(([, version]) => clone(version))
        .sort((left, right) =>
          String(left.definitionId) === String(right.definitionId)
            ? left.version - right.version
            : String(left.definitionId).localeCompare(String(right.definitionId)),
        ),
    );
  }
}

export class InMemoryWorkflowDraftRepository implements WorkflowDraftRepository {
  private readonly drafts = new Map<string, WorkflowDraftRecord & { organizationId: string }>();

  async save(input: {
    organizationId: OrganizationId;
    definition: WorkflowDefinition;
    expectedRevision: number | null;
    updatedAt: string;
  }): Result.ResultAsync<
    { type: "saved"; revision: number } | { type: "conflict" },
    WorkflowRepositoryError
  > {
    const id = key(input.organizationId, input.definition.id);
    const existing = this.drafts.get(id);
    if ((existing?.revision ?? null) !== input.expectedRevision)
      return Result.succeed({ type: "conflict" });
    const revision = (existing?.revision ?? 0) + 1;
    this.drafts.set(id, {
      organizationId: String(input.organizationId),
      definition: clone(input.definition),
      revision,
      updatedAt: input.updatedAt,
    });
    return Result.succeed({ type: "saved", revision });
  }

  async load(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
  }): Result.ResultAsync<WorkflowDraftRecord | null, WorkflowRepositoryError> {
    const found = this.drafts.get(key(input.organizationId, input.definitionId));
    if (!found) return Result.succeed(null);
    const { organizationId: _organizationId, ...record } = found;
    return Result.succeed(clone(record));
  }

  async list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<WorkflowDraftRecord[], WorkflowRepositoryError> {
    return Result.succeed(
      [...this.drafts.values()]
        .filter((draft) => draft.organizationId === String(input.organizationId))
        .map(({ organizationId: _organizationId, ...record }) => clone(record)),
    );
  }
}

/**
 * In-memory WorkflowRun store。revision CASと監査イベントの原子的保存を再現し、
 * test hookでsave直前のcrash（`failNextSaves`）を注入できる。
 */
export class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private readonly runs = new Map<string, WorkflowRunRecord>();
  private readonly events: WorkflowAuditEvent[] = [];
  private readonly eventKeys = new Set<string>();
  /** Test hook: 次のN回のsaveを保存前に失敗させる（crashの模擬）。 */
  failNextSaves = 0;

  private append(events: readonly WorkflowAuditEvent[]): void {
    for (const event of events) {
      if (this.eventKeys.has(event.eventKey)) continue;
      this.eventKeys.add(event.eventKey);
      this.events.push(clone(event));
    }
  }

  async create(input: {
    record: WorkflowRunRecord;
    events: readonly WorkflowAuditEvent[];
  }): Result.ResultAsync<
    { type: "created" } | { type: "existing"; record: WorkflowRunRecord },
    WorkflowRepositoryError
  > {
    const id = key(input.record.state.organizationId, input.record.state.runId);
    const existing = this.runs.get(id);
    if (existing) return Result.succeed({ type: "existing", record: clone(existing) });
    const parent = input.record.invocation.parentAction?.actionRequestId;
    if (parent !== undefined) {
      const duplicate = [...this.runs.values()].find(
        (run) =>
          String(run.state.organizationId) === String(input.record.state.organizationId) &&
          String(run.invocation.parentAction?.actionRequestId) === String(parent),
      );
      if (duplicate) return Result.succeed({ type: "existing", record: clone(duplicate) });
    }
    this.runs.set(id, clone({ ...input.record, revision: 1 }));
    this.append(input.events);
    return Result.succeed({ type: "created" });
  }

  async load(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowRunRecord | null, WorkflowRepositoryError> {
    const found = this.runs.get(key(input.organizationId, input.runId));
    return Result.succeed(found ? clone(found) : null);
  }

  async save(input: {
    record: WorkflowRunRecord;
    expectedRevision: number;
    events: readonly WorkflowAuditEvent[];
  }): Result.ResultAsync<WorkflowRunSaveResult, WorkflowRepositoryError> {
    if (this.failNextSaves > 0) {
      this.failNextSaves -= 1;
      return Result.fail(
        new WorkflowRepositoryError("injected_crash", true, "injected crash before save"),
      );
    }
    const id = key(input.record.state.organizationId, input.record.state.runId);
    const existing = this.runs.get(id);
    if (!existing || existing.revision !== input.expectedRevision)
      return Result.succeed({ type: "conflict" });
    const revision = existing.revision + 1;
    this.runs.set(id, clone({ ...input.record, revision }));
    this.append(input.events);
    return Result.succeed({ type: "saved", revision });
  }

  async findByParentAction(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<WorkflowRunRecord | null, WorkflowRepositoryError> {
    const found = [...this.runs.values()].find(
      (run) =>
        String(run.state.organizationId) === String(input.organizationId) &&
        String(run.invocation.parentAction?.actionRequestId) === String(input.actionRequestId),
    );
    return Result.succeed(found ? clone(found) : null);
  }

  async listDue(input: {
    now: string;
    limit: number;
  }): Result.ResultAsync<
    { organizationId: OrganizationId; runId: WorkflowRunId }[],
    WorkflowRepositoryError
  > {
    return Result.succeed(
      [...this.runs.values()]
        .filter(
          (run) =>
            run.wakeAt !== undefined &&
            Date.parse(run.wakeAt) <= Date.parse(input.now) &&
            (!isTerminalWorkflowRunStatus(run.state.status) || !run.completionDelivered),
        )
        .slice(0, input.limit)
        .map((run) => ({ organizationId: run.state.organizationId, runId: run.state.runId })),
    );
  }

  async list(input: {
    organizationId: OrganizationId;
    limit: number;
  }): Result.ResultAsync<WorkflowRunRecord[], WorkflowRepositoryError> {
    return Result.succeed(
      [...this.runs.values()]
        .filter((run) => String(run.state.organizationId) === String(input.organizationId))
        .slice(-input.limit)
        .reverse()
        .map(clone),
    );
  }

  async listEvents(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowAuditEvent[], WorkflowRepositoryError> {
    return Result.succeed(
      this.events
        .filter(
          (event) =>
            String(event.organizationId) === String(input.organizationId) &&
            String(event.runId) === String(input.runId),
        )
        .map(clone),
    );
  }
}
