import { Result } from "@praha/byethrow";

import { parseBrand, type Action, type OrganizationId } from "@app/approval-core";
import type { ActionRequestPreparation } from "@app/approval-application";
import { WorkflowRepositoryError } from "@app/workflow-application";

import { allRows, changes, firstRow, parseJson, runBatch, runStatement } from "./d1.ts";
import type { D1DatabaseLike } from "./d1.ts";

export type WorkflowSchedule = {
  organizationId: OrganizationId;
  id: string;
  key: string;
  ownerUserId: string;
  clientId: string;
  cron: string;
  action: Action;
  correlation: Record<string, string>;
  status: "active" | "stopped";
  nextSlotAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowScheduleSlot = {
  organizationId: OrganizationId;
  scheduleId: string;
  slotAt: string;
  actionRequestId: string;
  status: "pending" | "running" | "accepted" | "denied" | "failed" | "skipped";
  preparation: ActionRequestPreparation | null;
  attemptCount: number;
  lockedUntil: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

type ScheduleRow = {
  organization_id: string;
  schedule_id: string;
  schedule_key: string;
  owner_user_id: string;
  client_id: string;
  cron: string;
  action_json: string;
  correlation_json: string;
  status: "active" | "stopped";
  next_slot_at: string | null;
  created_at: string;
  updated_at: string;
};

type SlotRow = {
  organization_id: string;
  schedule_id: string;
  slot_at: string;
  action_request_id: string;
  status: WorkflowScheduleSlot["status"];
  preparation_json: string | null;
  attempt_count: number;
  locked_until: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

function mapSchedule(row: ScheduleRow): Result.Result<WorkflowSchedule, WorkflowRepositoryError> {
  const organizationId = parseBrand("OrganizationId", row.organization_id);
  if (Result.isFailure(organizationId))
    return Result.fail(
      new WorkflowRepositoryError(
        "invalid_stored_organization_id",
        false,
        "Stored organization ID is invalid",
      ),
    );
  const action = parseJson<Action>(row.action_json);
  if (Result.isFailure(action)) return action;
  const correlation = parseJson<Record<string, string>>(row.correlation_json);
  if (Result.isFailure(correlation)) return correlation;
  return Result.succeed({
    organizationId: organizationId.value,
    id: row.schedule_id,
    key: row.schedule_key,
    ownerUserId: row.owner_user_id,
    clientId: row.client_id,
    cron: row.cron,
    action: action.value,
    correlation: correlation.value,
    status: row.status,
    nextSlotAt: row.next_slot_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapSlot(row: SlotRow): Result.Result<WorkflowScheduleSlot, WorkflowRepositoryError> {
  const organizationId = parseBrand("OrganizationId", row.organization_id);
  if (Result.isFailure(organizationId))
    return Result.fail(
      new WorkflowRepositoryError(
        "invalid_stored_organization_id",
        false,
        "Stored organization ID is invalid",
      ),
    );
  const preparation = row.preparation_json
    ? parseJson<ActionRequestPreparation>(row.preparation_json)
    : Result.succeed(null);
  if (Result.isFailure(preparation)) return preparation;
  return Result.succeed({
    organizationId: organizationId.value,
    scheduleId: row.schedule_id,
    slotAt: row.slot_at,
    actionRequestId: row.action_request_id,
    status: row.status,
    preparation: preparation.value,
    attemptCount: row.attempt_count,
    lockedUntil: row.locked_until,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function mappedRows<T, U>(
  rows: Result.ResultAsync<T[], WorkflowRepositoryError>,
  map: (row: T) => Result.Result<U, WorkflowRepositoryError>,
): Result.ResultAsync<U[], WorkflowRepositoryError> {
  const loaded = await rows;
  if (Result.isFailure(loaded)) return loaded;
  const result: U[] = [];
  for (const row of loaded.value) {
    const mapped = map(row);
    if (Result.isFailure(mapped)) return mapped;
    result.push(mapped.value);
  }
  return Result.succeed(result);
}

export class D1WorkflowScheduleRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async create(schedule: WorkflowSchedule): Result.ResultAsync<boolean, WorkflowRepositoryError> {
    const saved = await runStatement(
      this.db
        .prepare(`INSERT OR IGNORE INTO workflow_schedules
          (organization_id, schedule_id, schedule_key, owner_user_id, client_id, cron,
           action_json, correlation_json, status, next_slot_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          String(schedule.organizationId),
          schedule.id,
          schedule.key,
          schedule.ownerUserId,
          schedule.clientId,
          schedule.cron,
          JSON.stringify(schedule.action),
          JSON.stringify(schedule.correlation),
          schedule.status,
          schedule.nextSlotAt,
          schedule.createdAt,
          schedule.updatedAt,
        ),
    );
    return Result.isFailure(saved) ? saved : Result.succeed(changes(saved.value) === 1);
  }

  async findByKey(input: {
    organizationId: OrganizationId;
    key: string;
  }): Result.ResultAsync<WorkflowSchedule | null, WorkflowRepositoryError> {
    const row = await firstRow<ScheduleRow>(
      this.db
        .prepare("SELECT * FROM workflow_schedules WHERE organization_id = ? AND schedule_key = ?")
        .bind(String(input.organizationId), input.key),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? mapSchedule(row.value) : Result.succeed(null);
  }

  async find(input: {
    organizationId: OrganizationId;
    id: string;
  }): Result.ResultAsync<WorkflowSchedule | null, WorkflowRepositoryError> {
    const row = await firstRow<ScheduleRow>(
      this.db
        .prepare("SELECT * FROM workflow_schedules WHERE organization_id = ? AND schedule_id = ?")
        .bind(String(input.organizationId), input.id),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? mapSchedule(row.value) : Result.succeed(null);
  }

  list(input: { organizationId: OrganizationId; ownerUserId: string }) {
    return mappedRows(
      allRows<ScheduleRow>(
        this.db
          .prepare(
            "SELECT * FROM workflow_schedules WHERE organization_id = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT 200",
          )
          .bind(String(input.organizationId), input.ownerUserId),
      ),
      mapSchedule,
    );
  }

  due(input: { organizationId: OrganizationId; now: string }) {
    return mappedRows(
      allRows<ScheduleRow>(
        this.db
          .prepare(
            "SELECT * FROM workflow_schedules WHERE organization_id = ? AND status = 'active' AND next_slot_at <= ? ORDER BY next_slot_at LIMIT 100",
          )
          .bind(String(input.organizationId), input.now),
      ),
      mapSchedule,
    );
  }

  async setStatus(input: {
    organizationId: OrganizationId;
    id: string;
    ownerUserId: string;
    status: "active" | "stopped";
    nextSlotAt: string | null;
    now: string;
  }) {
    const statements = [
      this.db
        .prepare(
          "UPDATE workflow_schedules SET status = ?, next_slot_at = ?, updated_at = ? WHERE organization_id = ? AND schedule_id = ? AND owner_user_id = ?",
        )
        .bind(
          input.status,
          input.nextSlotAt,
          input.now,
          String(input.organizationId),
          input.id,
          input.ownerUserId,
        ),
    ];
    if (input.status === "stopped") {
      statements.push(
        this.db
          .prepare(
            `UPDATE workflow_schedule_slots SET status = 'skipped', error_code = 'schedule_stopped', updated_at = ?
         WHERE organization_id = ? AND schedule_id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM workflow_schedules WHERE organization_id = ? AND schedule_id = ? AND owner_user_id = ? AND status = 'stopped')`,
          )
          .bind(
            input.now,
            String(input.organizationId),
            input.id,
            String(input.organizationId),
            input.id,
            input.ownerUserId,
          ),
      );
    }
    const saved = await runBatch({ db: this.db, statements });
    return Result.isFailure(saved) ? saved : Result.succeed(changes(saved.value[0]) === 1);
  }

  /** CAS advances the cursor and creates the slot in one D1 transaction. */
  async enqueueSlot(input: { schedule: WorkflowSchedule; nextSlotAt: string; now: string }) {
    const schedule = input.schedule;
    const actionRequestId = `schedule:${schedule.id}:${schedule.nextSlotAt}`;
    const saved = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `UPDATE workflow_schedules SET next_slot_at = ?, updated_at = ?
         WHERE organization_id = ? AND schedule_id = ? AND status = 'active' AND next_slot_at = ?`,
          )
          .bind(
            input.nextSlotAt,
            input.now,
            String(schedule.organizationId),
            schedule.id,
            schedule.nextSlotAt,
          ),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_schedule_slots
         (organization_id, schedule_id, slot_at, action_request_id, status, created_at, updated_at)
         SELECT organization_id, schedule_id, ?, ?, 'pending', ?, ?
         FROM workflow_schedules WHERE organization_id = ? AND schedule_id = ? AND status = 'active'
           AND next_slot_at = ?`,
          )
          .bind(
            schedule.nextSlotAt,
            actionRequestId,
            input.now,
            input.now,
            String(schedule.organizationId),
            schedule.id,
            input.nextSlotAt,
          ),
      ],
    });
    return Result.isFailure(saved) ? saved : Result.succeed(changes(saved.value[0]) === 1);
  }

  pending(input: { organizationId: OrganizationId; now: string }) {
    return mappedRows(
      allRows<SlotRow>(
        this.db
          .prepare(
            `SELECT sl.* FROM workflow_schedule_slots sl
       JOIN workflow_schedules s ON s.organization_id = sl.organization_id AND s.schedule_id = sl.schedule_id
       WHERE sl.organization_id = ? AND s.status = 'active'
         AND (sl.status = 'pending' OR (sl.status = 'running' AND sl.locked_until <= ?))
       ORDER BY sl.slot_at LIMIT 100`,
          )
          .bind(String(input.organizationId), input.now),
      ),
      mapSlot,
    );
  }

  /** A previous Composite Action is still running or waiting. */
  async hasActiveRun(input: {
    slot: WorkflowScheduleSlot;
  }): Result.ResultAsync<boolean, WorkflowRepositoryError> {
    const row = await firstRow<{ run_id: string }>(
      this.db
        .prepare(
          `SELECT w.run_id FROM workflow_schedule_slots sl
         JOIN workflow_runs w ON w.organization_id = sl.organization_id
           AND w.parent_action_request_id = sl.action_request_id
         WHERE sl.organization_id = ? AND sl.schedule_id = ? AND sl.slot_at < ?
           AND w.status IN ('running', 'waiting') LIMIT 1`,
        )
        .bind(String(input.slot.organizationId), input.slot.scheduleId, input.slot.slotAt),
    );
    return Result.isFailure(row) ? row : Result.succeed(row.value !== null);
  }

  async claimSlot(input: { slot: WorkflowScheduleSlot; now: string; lockedUntil: string }) {
    const saved = await runStatement(
      this.db
        .prepare(
          `UPDATE workflow_schedule_slots SET status = 'running', locked_until = ?,
       attempt_count = attempt_count + 1, updated_at = ?
       WHERE organization_id = ? AND schedule_id = ? AND slot_at = ?
         AND (status = 'pending' OR (status = 'running' AND locked_until <= ?))`,
        )
        .bind(
          input.lockedUntil,
          input.now,
          String(input.slot.organizationId),
          input.slot.scheduleId,
          input.slot.slotAt,
          input.now,
        ),
    );
    return Result.isFailure(saved) ? saved : Result.succeed(changes(saved.value) === 1);
  }

  async savePreparation(input: {
    slot: WorkflowScheduleSlot;
    preparation: ActionRequestPreparation;
    now: string;
  }) {
    const saved = await runStatement(
      this.db
        .prepare(
          `UPDATE workflow_schedule_slots SET preparation_json = ?, updated_at = ?
       WHERE organization_id = ? AND schedule_id = ? AND slot_at = ? AND status = 'running' AND preparation_json IS NULL`,
        )
        .bind(
          JSON.stringify(input.preparation),
          input.now,
          String(input.slot.organizationId),
          input.slot.scheduleId,
          input.slot.slotAt,
        ),
    );
    return Result.isFailure(saved) ? saved : Result.succeed(changes(saved.value) === 1);
  }

  async finishSlot(input: {
    slot: WorkflowScheduleSlot;
    status: "accepted" | "denied" | "failed" | "pending" | "skipped";
    errorCode?: string;
    now: string;
  }) {
    const saved = await runStatement(
      this.db
        .prepare(
          `UPDATE workflow_schedule_slots SET status = ?, error_code = ?, locked_until = NULL, updated_at = ?
       WHERE organization_id = ? AND schedule_id = ? AND slot_at = ? AND status = 'running'`,
        )
        .bind(
          input.status,
          input.errorCode ?? null,
          input.now,
          String(input.slot.organizationId),
          input.slot.scheduleId,
          input.slot.slotAt,
        ),
    );
    return Result.isFailure(saved) ? saved : Result.succeed(changes(saved.value) === 1);
  }

  slots(input: { organizationId: OrganizationId; scheduleId: string }) {
    return mappedRows(
      allRows<SlotRow>(
        this.db
          .prepare(
            `SELECT * FROM workflow_schedule_slots WHERE organization_id = ? AND schedule_id = ?
       ORDER BY slot_at DESC LIMIT 200`,
          )
          .bind(String(input.organizationId), input.scheduleId),
      ),
      mapSlot,
    );
  }
}
