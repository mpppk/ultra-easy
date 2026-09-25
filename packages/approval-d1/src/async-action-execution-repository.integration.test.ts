import { Result } from "@praha/byethrow";
import { assert, beforeEach, describe, expect, it } from "vite-plus/test";

import { ActionExecutionCompletionService } from "@app/approval-application";
import { asyncExecutionAcceptedEvents, foldActionRequestStatus } from "@app/approval-core";
import type {
  ActionFingerprint,
  ActionRequestId,
  AsyncActionExecutionRecord,
  ExecutorKey,
  OrganizationId,
} from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import { D1ActionResultProjectionRepository } from "./action-result-projection-repository.ts";
import { D1AsyncActionExecutionRepository } from "./async-action-execution-repository.ts";
import { migratedSqliteD1, type SqliteD1Database } from "./testing/sqlite-d1.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:async-d1");
const actionRequestId = branded<ActionRequestId>("action:async-d1");
const record: AsyncActionExecutionRecord = {
  organizationId,
  actionRequestId,
  actionFingerprint: branded<ActionFingerprint>("sha256:fp"),
  executionRef: "run:action:async-d1",
  idempotencyKey: "ue:v1:org:action:fp",
  executorKey: branded<ExecutorKey>("workflow"),
  guaranteeLevel: "idempotent",
  workflowInstanceId: "ue_instance",
  status: "accepted",
  acceptedAt: "2026-09-25T00:00:00.000Z",
};

let db: SqliteD1Database;
let repository: D1AsyncActionExecutionRepository;
let events: D1ActionEventRepository;
let results: D1ActionResultProjectionRepository;
let service: ActionExecutionCompletionService;

beforeEach(async () => {
  db = migratedSqliteD1();
  repository = new D1AsyncActionExecutionRepository(db);
  events = new D1ActionEventRepository(db);
  results = new D1ActionResultProjectionRepository(db);
  service = new ActionExecutionCompletionService({ asyncExecutions: repository, results, events });
  const accepted = await repository.accept({
    record,
    events: asyncExecutionAcceptedEvents({
      organizationId,
      actionRequestId,
      authorizationEvidence: {
        evaluatedAt: record.acceptedAt,
        consistency: "higher_consistency",
      },
      idempotencyKey: record.idempotencyKey,
      executionRef: record.executionRef,
      acceptedAt: record.acceptedAt,
    }),
  });
  assert(Result.isSuccess(accepted) && accepted.value.type === "accepted");
});

async function status() {
  const listed = await events.listForAction({ organizationId, actionRequestId });
  assert(Result.isSuccess(listed));
  return foldActionRequestStatus(
    listed.value.map((event) => event.event),
    { approvalRequired: false },
  );
}

const completion = {
  organizationId,
  actionRequestId,
  actionFingerprint: record.actionFingerprint,
  executionRef: record.executionRef,
  idempotencyKey: record.idempotencyKey,
  completion: { status: "executed" as const, output: { ok: true } },
  completedAt: "2026-09-25T01:00:00.000Z",
};

describe("D1 async Action execution (#165)", () => {
  it("accepted -> wait -> trusted completion is persisted exactly once", async () => {
    expect(await status()).toBe("executing");
    const replayedAccept = await repository.accept({ record, events: [] });
    expect(Result.isSuccess(replayedAccept) && replayedAccept.value.type).toBe("existing");

    const completed = await service.complete(completion);
    expect(Result.isSuccess(completed) && completed.value.type).toBe("completed");
    expect(await status()).toBe("executed");
    const stored = await results.load({ organizationId, actionRequestId });
    expect(Result.isSuccess(stored) && stored.value).toMatchObject({
      status: "executed",
      workflowInstanceId: "ue_instance",
      result: { status: "succeeded", output: { ok: true } },
    });

    const replay = await service.complete(completion);
    expect(Result.isSuccess(replay) && replay.value.type).toBe("replayed");
    const conflict = await service.complete({
      ...completion,
      completion: { status: "execution_failed", code: "late", message: "late" },
    });
    expect(Result.isFailure(conflict) && conflict.error.code).toBe("completion_conflict");
    expect(await status()).toBe("executed");
  });

  it("CAS fences completion against binding mismatch and cancel races", async () => {
    const spoofed = await repository.settle({ ...completion, executionRef: "run:other" });
    expect(Result.isSuccess(spoofed) && spoofed.value.type).toBe("not_found");

    const cancel = await repository.requestCancel({
      organizationId,
      actionRequestId,
      reason: "cancel",
      requestedAt: "2026-09-25T00:30:00.000Z",
    });
    expect(Result.isSuccess(cancel) && cancel.value.type).toBe("cancel_requested");

    const [first, second] = await Promise.all([
      repository.settle({
        ...completion,
        completion: { status: "execution_failed", code: "execution_cancelled", message: "c" },
      }),
      repository.settle(completion),
    ]);
    const outcomes = [first, second].map((result) =>
      Result.isSuccess(result) ? result.value.type : "error",
    );
    expect(outcomes.sort()).toEqual(["already_settled", "settled"]);
    const loaded = await repository.load({ organizationId, actionRequestId });
    expect(Result.isSuccess(loaded) && loaded.value?.status).toBe("completed");
  });
});
