import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { ActionRequestApplicationService } from "@app/approval-application";
import { brandLiteral } from "@app/approval-core";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import { D1WorkflowScheduleRepository } from "@app/workflow-d1";

import type { Auth0IdentityProvider } from "./auth0-identity.ts";
import { createPublicScheduleApi, sweepWorkflowSchedules } from "./schedule-api.ts";

const ORGANIZATION_ID = brandLiteral("OrganizationId", "organization:staging");
const OWNER = { type: "user" as const, id: brandLiteral("UserId", "user:owner") };

function identity() {
  return {
    authenticateWithClient: async () =>
      Result.succeed({
        principal: OWNER,
        clientId: brandLiteral("ClientId", "knowledge-web"),
      }),
  } as unknown as Auth0IdentityProvider;
}

function service(calls: { prepare: number; commit: number }) {
  return {
    prepare: async (input: { actionRequestId?: string }) => {
      calls.prepare += 1;
      return Result.succeed({
        type: "prepared",
        prepared: {
          actionRequestId: input.actionRequestId ?? "registration",
          organizationId: ORGANIZATION_ID,
        },
      });
    },
    commit: async () => {
      calls.commit += 1;
      return Result.succeed({ type: "accepted" });
    },
  } as unknown as ActionRequestApplicationService;
}

function request(path: string, body?: unknown): Request {
  return new Request(
    `https://approval.example${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}

const BASE = "/v1/organizations/organization%3Astaging/schedules";
const BODY = {
  key: "knowledge:maintain:space-1",
  cron: "0 0 * * 1",
  action: {
    type: "knowledge.maintain_space",
    resource: { type: "knowledge_space", id: "space-1" },
    input: { spaceId: "space-1" },
  },
  correlation: { spaceId: "space-1" },
};

describe("public Schedule API and dispatcher", () => {
  it("denies a slot when the registering client grant has been revoked", async () => {
    const db = migratedSqliteD1() as unknown as D1Database;
    const calls = { prepare: 0, commit: 0 };
    const actionService = service(calls);
    const api = createPublicScheduleApi({
      db,
      organizationId: ORGANIZATION_ID,
      identity: identity(),
      service: actionService,
    });
    const created = await api.fetch(request(BASE, BODY));
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { id: string; nextSlotAt: string };
    const result = await sweepWorkflowSchedules({
      db,
      organizationId: ORGANIZATION_ID,
      service: actionService,
      clientAllowed: () => false,
      now: schedule.nextSlotAt,
    });
    expect(Result.isSuccess(result) && result.value.processed).toBe(0);
    expect(calls.commit).toBe(0);
    const slots = await new D1WorkflowScheduleRepository(db).slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule.id,
    });
    expect(Result.isSuccess(slots) && slots.value[0]).toMatchObject({
      status: "denied",
      errorCode: "client_grant_revoked",
    });
  });

  it("registers idempotently, starts one ActionRequest per slot, and skips slots after stop", async () => {
    const db = migratedSqliteD1() as unknown as D1Database;
    const calls = { prepare: 0, commit: 0 };
    const actionService = service(calls);
    const api = createPublicScheduleApi({
      db,
      organizationId: ORGANIZATION_ID,
      identity: identity(),
      service: actionService,
    });
    const created = await api.fetch(request(BASE, BODY));
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { id: string; nextSlotAt: string };
    expect(schedule.nextSlotAt).toMatch(/T00:00:00\.000Z$/);
    const replay = await api.fetch(request(BASE, BODY));
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { id: string }).id).toBe(schedule.id);

    const repository = new D1WorkflowScheduleRepository(db);
    const dueAt = schedule.nextSlotAt;
    const first = await sweepWorkflowSchedules({
      db,
      organizationId: ORGANIZATION_ID,
      service: actionService,
      clientAllowed: () => true,
      now: dueAt,
    });
    const second = await sweepWorkflowSchedules({
      db,
      organizationId: ORGANIZATION_ID,
      service: actionService,
      clientAllowed: () => true,
      now: dueAt,
    });
    expect(Result.isSuccess(first) && first.value.processed).toBe(1);
    expect(Result.isSuccess(second) && second.value.processed).toBe(0);
    expect(calls.commit).toBe(1);
    const slots = await repository.slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule.id,
    });
    expect(Result.isSuccess(slots) && slots.value).toMatchObject([
      { status: "accepted", slotAt: dueAt },
    ]);

    if (Result.isFailure(slots) || !slots.value[0]) return expect.fail("slot missing");
    await db
      .prepare(`INSERT INTO workflow_runs
      (organization_id, run_id, definition_id, version, checksum, status, depth,
       parent_action_request_id, invocation_json, state_json, revision, last_writer, created_at, updated_at)
      VALUES (?, 'run:waiting', 'maintenance', 1, 'checksum', 'waiting', 0, ?, '{}', '{}', 0, 'test', ?, ?)`)
      .bind(String(ORGANIZATION_ID), slots.value[0].actionRequestId, dueAt, dueAt)
      .run();
    const loaded = await repository.find({ organizationId: ORGANIZATION_ID, id: schedule.id });
    if (Result.isFailure(loaded) || !loaded.value?.nextSlotAt)
      return expect.fail("schedule missing");
    const waiting = await sweepWorkflowSchedules({
      db,
      organizationId: ORGANIZATION_ID,
      service: actionService,
      clientAllowed: () => true,
      now: loaded.value.nextSlotAt,
    });
    expect(Result.isSuccess(waiting) && waiting.value.processed).toBe(0);
    const laterSlots = await repository.slots({
      organizationId: ORGANIZATION_ID,
      scheduleId: schedule.id,
    });
    expect(Result.isSuccess(laterSlots) && laterSlots.value[0]).toMatchObject({
      status: "skipped",
      errorCode: "previous_run_active",
    });
    expect(calls.commit).toBe(1);

    const stop = await api.fetch(request(`${BASE}/${encodeURIComponent(schedule.id)}/stop`, {}));
    expect(stop.status).toBe(200);
    const afterStop = await sweepWorkflowSchedules({
      db,
      organizationId: ORGANIZATION_ID,
      service: actionService,
      clientAllowed: () => true,
      now: "2026-12-31T00:00:00.000Z",
    });
    expect(Result.isSuccess(afterStop) && afterStop.value.processed).toBe(0);
    expect(calls.commit).toBe(1);
  });
});
