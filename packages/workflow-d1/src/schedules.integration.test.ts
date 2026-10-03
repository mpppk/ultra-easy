import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { brandLiteral } from "@app/approval-core";
import { migratedSqliteD1 } from "@app/approval-d1/testing";

import type { D1DatabaseLike } from "./d1.ts";
import { D1WorkflowScheduleRepository, type WorkflowSchedule } from "./schedules.ts";

const ORGANIZATION_ID = brandLiteral("OrganizationId", "organization:staging");
const NOW = "2026-10-03T00:00:00.000Z";
const NEXT = "2026-10-05T00:00:00.000Z";

function schedule(): WorkflowSchedule {
  return {
    organizationId: ORGANIZATION_ID,
    id: "schedule:00000000-0000-4000-8000-000000000001",
    key: "knowledge:maintain:space-1",
    ownerUserId: "user:owner",
    clientId: "knowledge-web",
    cron: "0 0 * * 1",
    action: {
      type: brandLiteral("ActionType", "knowledge.maintain_space"),
      resource: {
        type: brandLiteral("ResourceType", "knowledge_space"),
        id: brandLiteral("ResourceId", "space-1"),
      },
      input: { spaceId: "space-1" },
    },
    correlation: { spaceId: "space-1" },
    status: "active",
    nextSlotAt: NEXT,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("D1WorkflowScheduleRepository", () => {
  it("enqueues each slot once even when two dispatchers race", async () => {
    const db = migratedSqliteD1() as unknown as D1DatabaseLike;
    const repository = new D1WorkflowScheduleRepository(db);
    const saved = await repository.create(schedule());
    expect(Result.isSuccess(saved) && saved.value).toBe(true);
    const first = await repository.enqueueSlot({
      schedule: schedule(),
      nextSlotAt: "2026-10-12T00:00:00.000Z",
      now: NEXT,
    });
    const second = await repository.enqueueSlot({
      schedule: schedule(),
      nextSlotAt: "2026-10-12T00:00:00.000Z",
      now: NEXT,
    });
    expect(Result.isSuccess(first) && first.value).toBe(true);
    expect(Result.isSuccess(second) && second.value).toBe(false);
    const slots = await repository.slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule().id,
    });
    expect(Result.isSuccess(slots) && slots.value).toMatchObject([
      { slotAt: NEXT, status: "pending" },
    ]);
  });

  it("does not dispatch a stopped schedule or its pending slots", async () => {
    const db = migratedSqliteD1() as unknown as D1DatabaseLike;
    const repository = new D1WorkflowScheduleRepository(db);
    await repository.create(schedule());
    await repository.enqueueSlot({
      schedule: schedule(),
      nextSlotAt: "2026-10-12T00:00:00.000Z",
      now: NEXT,
    });
    const stopped = await repository.setStatus({
      organizationId: ORGANIZATION_ID,
      id: schedule().id,
      ownerUserId: "user:owner",
      status: "stopped",
      nextSlotAt: null,
      now: NEXT,
    });
    expect(Result.isSuccess(stopped) && stopped.value).toBe(true);
    const due = await repository.due({
      organizationId: ORGANIZATION_ID,
      now: "2026-10-19T00:00:00.000Z",
    });
    const pending = await repository.pending({
      organizationId: ORGANIZATION_ID,
      now: "2026-10-19T00:00:00.000Z",
    });
    expect(Result.isSuccess(due) && due.value).toEqual([]);
    expect(Result.isSuccess(pending) && pending.value).toEqual([]);
    const slots = await repository.slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule().id,
    });
    expect(Result.isSuccess(slots) && slots.value[0]?.status).toBe("skipped");
    await repository.setStatus({
      organizationId: ORGANIZATION_ID,
      id: schedule().id,
      ownerUserId: "user:owner",
      status: "active",
      nextSlotAt: "2026-10-26T00:00:00.000Z",
      now: NEXT,
    });
    const afterResume = await repository.pending({
      organizationId: ORGANIZATION_ID,
      now: "2026-10-26T00:00:00.000Z",
    });
    expect(Result.isSuccess(afterResume) && afterResume.value).toEqual([]);
  });

  it("detects a previous waiting run so the next weekly slot can be skipped", async () => {
    const db = migratedSqliteD1() as unknown as D1DatabaseLike;
    const repository = new D1WorkflowScheduleRepository(db);
    await repository.create(schedule());
    await repository.enqueueSlot({
      schedule: schedule(),
      nextSlotAt: "2026-10-12T00:00:00.000Z",
      now: NEXT,
    });
    const previous = await repository.slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule().id,
    });
    if (Result.isFailure(previous) || !previous.value[0]) return expect.fail("first slot missing");
    await db
      .prepare(`INSERT INTO workflow_runs
      (organization_id, run_id, definition_id, version, checksum, status, depth,
       parent_action_request_id, invocation_json, state_json, revision, last_writer, created_at, updated_at)
      VALUES (?, 'run:waiting', 'maintenance', 1, 'checksum', 'waiting', 0, ?, '{}', '{}', 0, 'test', ?, ?)`)
      .bind(String(ORGANIZATION_ID), previous.value[0].actionRequestId, NEXT, NEXT)
      .run();
    const current = await repository.find({ organizationId: ORGANIZATION_ID, id: schedule().id });
    if (Result.isFailure(current) || !current.value) return expect.fail("schedule missing");
    await repository.enqueueSlot({
      schedule: current.value,
      nextSlotAt: "2026-10-19T00:00:00.000Z",
      now: "2026-10-12T00:00:00.000Z",
    });
    const slots = await repository.slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule().id,
    });
    if (Result.isFailure(slots) || !slots.value[0]) return expect.fail("second slot missing");
    const active = await repository.hasActiveRun({ slot: slots.value[0] });
    expect(Result.isSuccess(active) && active.value).toBe(true);
  });
});
