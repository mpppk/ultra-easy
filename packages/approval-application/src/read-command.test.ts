import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { InMemoryFixedWindowRateLimiter, type RateLimitPolicy } from "@app/approval-core";

import type {
  ActionRequestId,
  ApprovalTaskId,
  JsonValue,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import {
  ApprovalDecisionCommandProcessor,
  ApprovalDecisionCommandService,
  PublicApiRepositoryError,
  createPublicHttpApi,
} from "./index.ts";
import type {
  ActionRequestView,
  ApprovalCommandRecord,
  ApprovalCommandRepository,
  ApprovalCommandStatus,
  ApprovalDecisionApplyResult,
  ApprovalDecisionSink,
  ApprovalReadRepository,
  ApprovalTaskDecisionContext,
  ApprovalTaskPage,
  ApprovalTaskView,
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyReserveResult,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:m6");
const actionRequestId = branded<ActionRequestId>("action-request:m6-2");
const taskId = branded<ApprovalTaskId>("task:m6-2");
const alice = branded<UserId>("user:alice");

const actionView: ActionRequestView = {
  id: String(actionRequestId),
  organizationId: String(organizationId),
  actor: { type: "user", id: alice },
  authorityPrincipal: { type: "user", id: alice },
  action: {
    type: "ticket.priority.change" as ActionRequestView["action"]["type"],
    resource: {
      type: "ticket" as ActionRequestView["action"]["resource"]["type"],
      id: "TICKET-1" as ActionRequestView["action"]["resource"]["id"],
    },
    input: { priority: "critical" },
  },
  origin: "api",
  status: "pending_approval",
  approval: { required: true, activeTaskCount: 1, completedTaskCount: 0 },
  checksums: {
    actionFingerprint: "sha256:action",
    evaluationSnapshotChecksum: "sha256:snapshot",
    approvalPlanChecksum: "sha256:plan",
  },
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
};

const taskView: ApprovalTaskView = {
  id: String(taskId),
  actionRequestId: String(actionRequestId),
  materializedStepId: "step:m6",
  stepKey: "manager",
  status: "pending",
  resolution: "snapshot",
  candidateCompletion: "any",
  canApprove: true,
  approverTarget: { kind: "user", userId: String(alice) },
  activatedAt: "2026-09-19T00:00:00.000Z",
};

class FakeReadRepository implements ApprovalReadRepository {
  action = structuredClone(actionView);
  task = structuredClone(taskView);
  decisionContext: Omit<ApprovalTaskDecisionContext, "task"> = {
    requireCommentOn: [],
    candidateUserIds: [String(alice)],
    decidedUserIds: [],
  };

  getApprovalTaskDecisionContext(input: { organizationId: OrganizationId }) {
    return Promise.resolve(
      Result.succeed(
        String(input.organizationId) === this.action.organizationId
          ? structuredClone({ ...this.decisionContext, task: this.task })
          : null,
      ),
    );
  }

  getActionRequest(input: { organizationId: OrganizationId }) {
    return Promise.resolve(
      Result.succeed(
        String(input.organizationId) === this.action.organizationId
          ? structuredClone(this.action)
          : null,
      ),
    );
  }

  getApprovalTask(input: { organizationId: OrganizationId }) {
    return Promise.resolve(
      Result.succeed(
        String(input.organizationId) === this.action.organizationId
          ? structuredClone(this.task)
          : null,
      ),
    );
  }

  listActionRequestTasks() {
    const page: ApprovalTaskPage = {
      items: [structuredClone(this.task)],
      pageInfo: { hasMore: false },
    };
    return Promise.resolve(Result.succeed(page));
  }

  listMyApprovalTasks() {
    const page: ApprovalTaskPage = {
      items: [structuredClone(this.task)],
      pageInfo: { hasMore: false },
    };
    return Promise.resolve(Result.succeed(page));
  }
}

class FakeCommandRepository implements ApprovalCommandRepository {
  readonly records = new Map<string, ApprovalCommandRecord>();
  readonly leases = new Map<string, string>();

  createPending(record: ApprovalCommandRecord) {
    const key = record.command.id;
    const existing = this.records.get(key);
    if (existing) {
      return Promise.resolve(Result.succeed({ type: "existing" as const, record: existing }));
    }
    this.records.set(key, structuredClone(record));
    return Promise.resolve(Result.succeed({ type: "created" as const }));
  }

  load(input: { organizationId: OrganizationId; commandId: string }) {
    const record = this.records.get(input.commandId);
    return Promise.resolve(
      Result.succeed(
        record?.command.organizationId === String(input.organizationId)
          ? structuredClone(record)
          : null,
      ),
    );
  }

  claim(input: {
    organizationId: OrganizationId;
    commandId: string;
    now: string;
    leaseUntil: string;
  }) {
    const current = this.records.get(input.commandId);
    if (
      !current ||
      current.command.organizationId !== String(input.organizationId) ||
      current.command.status !== "pending" ||
      (current.nextAttemptAt !== undefined && current.nextAttemptAt > input.now) ||
      (this.leases.get(input.commandId) ?? "") > input.now
    ) {
      return Promise.resolve(Result.succeed(null));
    }
    this.leases.set(input.commandId, input.leaseUntil);
    return Promise.resolve(Result.succeed(structuredClone(current)));
  }

  transition(input: {
    organizationId: OrganizationId;
    commandId: string;
    from: readonly ApprovalCommandStatus[];
    to: Exclude<ApprovalCommandStatus, "pending">;
    appliedAt?: string;
    error?: ApprovalCommandRecord["command"]["error"];
  }) {
    const current = this.records.get(input.commandId);
    if (!current || current.command.organizationId !== String(input.organizationId)) {
      return Promise.resolve(
        Result.fail(
          new PublicApiRepositoryError("approval_command_not_found", false, "command not found"),
        ),
      );
    }
    if (!input.from.includes(current.command.status)) {
      return Promise.resolve(
        Result.succeed({ type: "stale" as const, record: structuredClone(current) }),
      );
    }
    const updated: ApprovalCommandRecord = {
      ...current,
      command: {
        ...current.command,
        status: input.to,
        ...(input.appliedAt !== undefined ? { appliedAt: input.appliedAt } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
    };
    this.records.set(input.commandId, structuredClone(updated));
    this.leases.delete(input.commandId);
    return Promise.resolve(
      Result.succeed({ type: "updated" as const, record: structuredClone(updated) }),
    );
  }

  scheduleRetry(input: {
    organizationId: OrganizationId;
    commandId: string;
    nextAttemptAt: string;
    error: ApprovalCommandRecord["command"]["error"];
  }) {
    const current = this.records.get(input.commandId);
    if (!current || current.command.status !== "pending") {
      return Promise.resolve(
        Result.fail(
          new PublicApiRepositoryError("approval_command_not_found", false, "command not found"),
        ),
      );
    }
    const updated: ApprovalCommandRecord = {
      ...current,
      command: { ...current.command, ...(input.error ? { error: input.error } : {}) },
      attemptCount: (current.attemptCount ?? 0) + 1,
      nextAttemptAt: input.nextAttemptAt,
    };
    this.records.set(input.commandId, structuredClone(updated));
    this.leases.delete(input.commandId);
    return Promise.resolve(
      Result.succeed({ type: "updated" as const, record: structuredClone(updated) }),
    );
  }

  listDuePending(input: { now: string; limit: number }) {
    const records = [...this.records.values()]
      .filter(
        (record) =>
          record.command.status === "pending" &&
          (record.nextAttemptAt === undefined || record.nextAttemptAt <= input.now),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
    return Promise.resolve(Result.succeed(records));
  }
}

class FakeIdempotencyRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();

  private key(record: { organizationId: OrganizationId; operation: string; key: string }) {
    return `${String(record.organizationId)}|${record.operation}|${record.key}`;
  }

  reserve(record: IdempotencyRecord) {
    const key = this.key(record);
    const existing = this.records.get(key);
    let result: IdempotencyReserveResult;
    if (!existing) {
      this.records.set(key, structuredClone(record));
      result = { type: "acquired", record };
    } else if (existing.requestHash !== record.requestHash) {
      result = { type: "conflict", record: existing };
    } else if (existing.status === "completed") {
      result = { type: "replay", record: existing };
    } else if (existing.lockedUntil === undefined || existing.lockedUntil <= record.updatedAt) {
      const taken = { ...existing, lockedUntil: record.lockedUntil, updatedAt: record.updatedAt };
      this.records.set(key, structuredClone(taken));
      result = { type: "acquired", record: taken };
    } else {
      result = { type: "in_progress", record: existing };
    }
    return Promise.resolve(Result.succeed(structuredClone(result)));
  }

  complete(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: JsonValue;
    responseLocation?: string;
    completedAt: string;
  }) {
    const key = this.key(input);
    const current = this.records.get(key);
    if (!current || current.requestHash !== input.requestHash) {
      return Promise.resolve(
        Result.fail(
          new PublicApiRepositoryError("idempotency_record_missing", false, "record missing"),
        ),
      );
    }
    const updated: IdempotencyRecord = {
      ...current,
      status: "completed",
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      ...(input.responseLocation !== undefined ? { responseLocation: input.responseLocation } : {}),
      updatedAt: input.completedAt,
    };
    this.records.set(key, structuredClone(updated));
    return Promise.resolve(Result.succeed(structuredClone(updated)));
  }

  release(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
  }) {
    const key = this.key(input);
    const current = this.records.get(key);
    if (current?.requestHash === input.requestHash && current.status === "pending") {
      this.records.delete(key);
    }
    return Promise.resolve(Result.succeed(undefined));
  }
}

class FakeSink implements ApprovalDecisionSink {
  calls = 0;
  results: Result.Result<ApprovalDecisionApplyResult, PublicApiRepositoryError>[] = [];

  apply() {
    this.calls += 1;
    return Promise.resolve(this.results.shift() ?? Result.succeed({ type: "applied" as const }));
  }
}

function createHarness(options: { rateLimitPolicy?: RateLimitPolicy } = {}) {
  const readRepository = new FakeReadRepository();
  const commandRepository = new FakeCommandRepository();
  let commandSequence = 0;
  const decisionService = new ApprovalDecisionCommandService(readRepository, commandRepository, {
    next() {
      commandSequence += 1;
      return `command:${commandSequence}`;
    },
  });
  const idempotencyRepository = new FakeIdempotencyRepository();
  let nowSequence = 0;
  const clock = {
    now() {
      nowSequence += 1;
      return `2026-09-19T00:00:0${Math.min(nowSequence, 9)}.000Z`;
    },
  };
  let createCalls = 0;
  const actionRequestApi = {
    async fetch() {
      createCalls += 1;
      return new Response(
        JSON.stringify({
          ...actionView,
          id: `action-request:create-${createCalls}`,
          status: "executed",
          approval: { required: false },
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json",
            location: `/v1/organizations/org%3Am6/action-requests/action-request%3Acreate-${createCalls}`,
          },
        },
      );
    },
  };
  const api = createPublicHttpApi({
    actionRequestApi,
    readRepository,
    decisionService,
    identityProvider: {
      resolveSubject() {
        return Promise.resolve(Result.succeed(String(alice)));
      },
      resolveUser() {
        return Promise.resolve(Result.succeed(alice));
      },
    },
    idempotencyRepository,
    clock,
    ...(options.rateLimitPolicy
      ? {
          rateLimiter: new InMemoryFixedWindowRateLimiter(),
          approvalDecisionRateLimitPolicy: options.rateLimitPolicy,
        }
      : {}),
  });
  return {
    api,
    readRepository,
    commandRepository,
    decisionService,
    idempotencyRepository,
    createCalls: () => createCalls,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://approval.test${path}`, init);
}

describe("M6-2 Read API / Decision command / Idempotency", () => {
  it("AC-M6-004/005: Decision POSTはpending commandを202で返し、適用はprocessorに分離する", async () => {
    const harness = createHarness();
    const sink = new FakeSink();
    const processor = new ApprovalDecisionCommandProcessor(harness.commandRepository, sink);

    const post = await harness.api.fetch(
      request(
        `/v1/organizations/org%3Am6/approval-tasks/${encodeURIComponent(String(taskId))}/decisions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "decision-1",
          },
          body: JSON.stringify({ decision: "approve", comment: "ok" }),
        },
      ),
    );
    expect(post.status).toBe(202);
    const accepted = (await post.json()) as { id: string; status: string };
    expect(accepted).toMatchObject({ id: "command:1", status: "pending" });
    expect(sink.calls).toBe(0);

    const actionImmediately = await harness.api.fetch(
      request(
        `/v1/organizations/org%3Am6/action-requests/${encodeURIComponent(String(actionRequestId))}`,
      ),
    );
    await expect(actionImmediately.json()).resolves.toMatchObject({
      status: "pending_approval",
    });

    const pending = await harness.api.fetch(
      request(`/v1/organizations/org%3Am6/approval-commands/${encodeURIComponent(accepted.id)}`),
    );
    await expect(pending.json()).resolves.toMatchObject({ status: "pending" });

    const processed = await processor.process({
      organizationId,
      commandId: accepted.id,
      now: "2026-09-19T00:01:00.000Z",
    });
    expect(Result.isSuccess(processed)).toBe(true);
    expect(sink.calls).toBe(1);

    const applied = await harness.api.fetch(
      request(`/v1/organizations/org%3Am6/approval-commands/${encodeURIComponent(accepted.id)}`),
    );
    await expect(applied.json()).resolves.toMatchObject({
      id: accepted.id,
      status: "applied",
    });
  });

  it("AC-M6-006: ActionRequest POSTの同一key + 同一payloadはresponseをreplayして重複実行しない", async () => {
    const harness = createHarness();
    const path = "/v1/organizations/org%3Am6/action-requests";
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-1",
      },
      body: JSON.stringify({
        action: {
          type: "ticket.priority.change",
          resource: { type: "ticket", id: "TICKET-1" },
          input: { priority: "normal" },
        },
      }),
    } satisfies RequestInit;

    const first = await harness.api.fetch(request(path, init));
    const second = await harness.api.fetch(request(path, init));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(harness.createCalls()).toBe(1);
  });

  function statusSequenceApi(statuses: number[], harness: ReturnType<typeof createHarness>) {
    let calls = 0;
    const api = createPublicHttpApi({
      actionRequestApi: {
        async fetch() {
          const status = statuses[Math.min(calls, statuses.length - 1)] ?? 201;
          calls += 1;
          return new Response(JSON.stringify({ attempt: calls, status }), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      },
      readRepository: harness.readRepository,
      decisionService: harness.decisionService,
      identityProvider: {
        resolveSubject() {
          return Promise.resolve(Result.succeed(String(alice)));
        },
        resolveUser() {
          return Promise.resolve(Result.succeed(alice));
        },
      },
      idempotencyRepository: harness.idempotencyRepository,
      clock: { now: () => "2026-09-19T00:00:00.000Z" },
    });
    return { api, calls: () => calls };
  }

  const createInit = (
    body: string = JSON.stringify({ action: { type: "ticket.priority.change" } }),
  ) =>
    ({
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "create-retry" },
      body,
    }) satisfies RequestInit;
  const createPath = "/v1/organizations/org%3Am6/action-requests";

  it("#92: Decision replayはrate limitを消費しない", async () => {
    const harness = createHarness({ rateLimitPolicy: { limit: 1, windowSeconds: 60 } });
    const decide = (key: string) =>
      harness.api.fetch(
        request(
          `/v1/organizations/org%3Am6/approval-tasks/${encodeURIComponent(String(taskId))}/decisions`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify({ decision: "approve" }),
          },
        ),
      );

    const first = await decide("decision-rate-1");
    const replay = await decide("decision-rate-1");
    const limited = await decide("decision-rate-2");
    const retriedAfterLimit = await decide("decision-rate-2");

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(limited.status).toBe(429);
    // 429は記録しないので、同じkeyは(window内なら再び)rate limitで判定される。
    expect(retriedAfterLimit.status).toBe(429);
    expect(harness.commandRepository.records.size).toBe(1);
  });

  it("#92: retriableな503は記録せずreleaseし、同keyのretryで処理を再実行する", async () => {
    const harness = createHarness();
    const failing = statusSequenceApi([503, 201], harness);

    const first = await failing.api.fetch(request(createPath, createInit()));
    const second = await failing.api.fetch(request(createPath, createInit()));
    const replay = await failing.api.fetch(request(createPath, createInit()));

    expect(first.status).toBe(503);
    expect(second.status).toBe(201);
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toEqual({ attempt: 2, status: 201 });
    expect(failing.calls()).toBe(2);
  });

  it("#92: 確定した500はcompletedとして記録し同じ応答を再生する", async () => {
    const harness = createHarness();
    const failing = statusSequenceApi([500, 201], harness);

    const first = await failing.api.fetch(request(createPath, createInit()));
    const second = await failing.api.fetch(request(createPath, createInit()));

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    await expect(second.json()).resolves.toEqual({ attempt: 1, status: 500 });
    expect(failing.calls()).toBe(1);
  });

  it("#92: pending予約はlease中は409 + Retry-After、期限切れなら同じkeyで再取得できる", async () => {
    const harness = createHarness();
    const api = statusSequenceApi([201], harness);
    const hashProbe = await api.api.fetch(
      request(createPath, {
        ...createInit(),
        headers: { "content-type": "application/json", "idempotency-key": "probe" },
      }),
    );
    expect(hashProbe.status).toBe(201);
    const probe = [...harness.idempotencyRepository.records.values()][0];
    assert(probe);
    // reserve後にcrashしたisolateのpending予約を模擬する。
    harness.idempotencyRepository.records.set(
      `${String(probe.organizationId)}|${probe.operation}|create-retry`,
      {
        ...probe,
        key: "create-retry",
        status: "pending",
        lockedUntil: "2026-09-19T00:00:30.000Z",
        responseStatus: undefined,
        responseBody: undefined,
      },
    );

    const locked = await api.api.fetch(request(createPath, createInit()));
    expect(locked.status).toBe(409);
    expect(locked.headers.get("retry-after")).toBe("30");
    await expect(locked.json()).resolves.toMatchObject({ code: "idempotency_request_in_progress" });

    const expired = createPublicHttpApi({
      actionRequestApi: {
        fetch: () => Promise.resolve(Response.json({ ok: true }, { status: 201 })),
      },
      readRepository: harness.readRepository,
      decisionService: harness.decisionService,
      identityProvider: {
        resolveSubject: () => Promise.resolve(Result.succeed(String(alice))),
        resolveUser: () => Promise.resolve(Result.succeed(alice)),
      },
      idempotencyRepository: harness.idempotencyRepository,
      clock: { now: () => "2026-09-19T00:01:00.000Z" },
    });
    const reacquired = await expired.fetch(request(createPath, createInit()));
    expect(reacquired.status).toBe(201);
  });

  it("#92: JSONとして読めないbodyもpayloadごとに区別してhashする", async () => {
    const harness = createHarness();
    const api = statusSequenceApi([400], harness);

    const first = await api.api.fetch(request(createPath, createInit("not-json-a")));
    const second = await api.api.fetch(request(createPath, createInit("not-json-b")));

    expect(first.status).toBe(400);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ code: "idempotency_key_reused" });
  });

  it("AC-M6-006: 同一key + 異なるpayloadは409にする", async () => {
    const harness = createHarness();
    const path = "/v1/organizations/org%3Am6/action-requests";
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "create-1",
    };

    const first = await harness.api.fetch(
      request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: {
            type: "ticket.priority.change",
            resource: { type: "ticket", id: "TICKET-1" },
            input: { priority: "normal" },
          },
        }),
      }),
    );
    const conflict = await harness.api.fetch(
      request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: {
            type: "ticket.priority.change",
            resource: { type: "ticket", id: "TICKET-1" },
            input: { priority: "critical" },
          },
        }),
      }),
    );

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "idempotency_key_reused",
    });
    expect(harness.createCalls()).toBe(1);
  });

  it("AC-M6-006: Decision再送は同じcommandIdを返しduplicate commandを作らない", async () => {
    const harness = createHarness();
    const path = `/v1/organizations/org%3Am6/approval-tasks/${encodeURIComponent(String(taskId))}/decisions`;
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "decision-1",
      },
      body: JSON.stringify({ decision: "approve" }),
    } satisfies RequestInit;

    const first = await harness.api.fetch(request(path, init));
    const second = await harness.api.fetch(request(path, init));

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    expect(harness.commandRepository.records.size).toBe(1);
  });

  it("AC-M7-001: cross-tenant ActionRequest/task lookupは404で存在を秘匿する", async () => {
    const harness = createHarness();
    const guessedActionId = encodeURIComponent(String(actionRequestId));
    const guessedTaskId = encodeURIComponent(String(taskId));

    const action = await harness.api.fetch(
      request(`/v1/organizations/org%3Aother/action-requests/${guessedActionId}`),
    );
    expect(action.status).toBe(404);

    const tasks = await harness.api.fetch(
      request(`/v1/organizations/org%3Aother/action-requests/${guessedActionId}/tasks`),
    );
    expect(tasks.status).toBe(404);

    const task = await harness.api.fetch(
      request(`/v1/organizations/org%3Aother/approval-tasks/${guessedTaskId}`),
    );
    expect(task.status).toBe(404);

    const decision = await harness.api.fetch(
      request(`/v1/organizations/org%3Aother/approval-tasks/${guessedTaskId}/decisions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "cross-tenant-decision",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
    expect(decision.status).toBe(404);

    const ownDecision = await harness.api.fetch(
      request(`/v1/organizations/org%3Am6/approval-tasks/${guessedTaskId}/decisions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "own-decision-for-command",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
    expect(ownDecision.status).toBe(202);
    const command = (await ownDecision.json()) as { id: string };

    const crossTenantCommand = await harness.api.fetch(
      request(`/v1/organizations/org%3Aother/approval-commands/${encodeURIComponent(command.id)}`),
    );
    expect(crossTenantCommand.status).toBe(404);

    const processor = new ApprovalDecisionCommandProcessor(
      harness.commandRepository,
      new FakeSink(),
    );
    const crossTenantProcess = await processor.process({
      organizationId: branded<OrganizationId>("org:other"),
      commandId: command.id,
      now: "2026-09-19T00:10:00.000Z",
    });
    expect(Result.isFailure(crossTenantProcess)).toBe(true);
    if (Result.isFailure(crossTenantProcess)) {
      expect(crossTenantProcess.error.code).toBe("approval_command_not_found");
    }
  });

  it("Read API: ActionRequest task list / inbox / task detailを同じread modelから返す", async () => {
    const harness = createHarness();

    const tasks = await harness.api.fetch(
      request(
        `/v1/organizations/org%3Am6/action-requests/${encodeURIComponent(String(actionRequestId))}/tasks`,
      ),
    );
    expect(tasks.status).toBe(200);
    await expect(tasks.json()).resolves.toMatchObject({
      items: [{ id: String(taskId), canApprove: true }],
      pageInfo: { hasMore: false },
    });

    const inbox = await harness.api.fetch(
      request("/v1/organizations/org%3Am6/me/approval-tasks?status=pending"),
    );
    expect(inbox.status).toBe(200);
    await expect(inbox.json()).resolves.toMatchObject({
      items: [{ id: String(taskId), status: "pending" }],
    });

    const detail = await harness.api.fetch(
      request(`/v1/organizations/org%3Am6/approval-tasks/${encodeURIComponent(String(taskId))}`),
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: String(taskId),
      actionRequestId: String(actionRequestId),
    });
  });

  it("#79: Decision受付時にclosed task・既決・自己承認・候補外・comment欠落を4xxで早期に拒否する", async () => {
    const cases: {
      name: string;
      mutate(harness: ReturnType<typeof createHarness>): void;
      body: Record<string, unknown>;
      status: number;
      code: string;
    }[] = [
      {
        name: "closed",
        mutate: (harness) => {
          harness.readRepository.task.status = "approved";
        },
        body: { decision: "approve" },
        status: 409,
        code: "approval_task_closed",
      },
      {
        name: "already-decided",
        mutate: (harness) => {
          harness.readRepository.decisionContext.decidedUserIds = [String(alice)];
        },
        body: { decision: "approve" },
        status: 409,
        code: "approval_user_already_decided",
      },
      {
        name: "self-approval",
        mutate: (harness) => {
          harness.readRepository.decisionContext.selfApprovalDeniedUserId = String(alice);
        },
        body: { decision: "approve" },
        status: 403,
        code: "approval_self_approval_denied",
      },
      {
        name: "not-candidate",
        mutate: (harness) => {
          harness.readRepository.decisionContext.candidateUserIds = ["user:bob"];
        },
        body: { decision: "approve" },
        status: 403,
        code: "approval_candidate_rejected",
      },
      {
        name: "comment-required",
        mutate: (harness) => {
          harness.readRepository.decisionContext.requireCommentOn = ["reject"];
        },
        body: { decision: "reject", comment: "   " },
        status: 422,
        code: "approval_comment_required",
      },
    ];

    for (const testCase of cases) {
      const harness = createHarness();
      testCase.mutate(harness);
      const response = await harness.api.fetch(
        request(
          `/v1/organizations/org%3Am6/approval-tasks/${encodeURIComponent(String(taskId))}/decisions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `precheck-${testCase.name}`,
            },
            body: JSON.stringify(testCase.body),
          },
        ),
      );
      expect(response.status, testCase.name).toBe(testCase.status);
      await expect(response.json()).resolves.toMatchObject({ code: testCase.code });
      expect(harness.commandRepository.records.size, testCase.name).toBe(0);
    }
  });

  async function acceptDecision(harness: ReturnType<typeof createHarness>, key: string) {
    const post = await harness.api.fetch(
      request(
        `/v1/organizations/org%3Am6/approval-tasks/${encodeURIComponent(String(taskId))}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ decision: "approve", comment: "ok" }),
        },
      ),
    );
    expect(post.status).toBe(202);
    return ((await post.json()) as { id: string }).id;
  }

  it("#88: retriableなsink失敗はpendingのままbackoffし、後続のsweepでdeliveredになる", async () => {
    const harness = createHarness();
    const commandId = await acceptDecision(harness, "retry-1");
    const sink = new FakeSink();
    sink.results = [
      Result.fail(new PublicApiRepositoryError("decision_workflow_send_failed", true, "timeout")),
      Result.succeed({ type: "delivered" }),
    ];
    const processor = new ApprovalDecisionCommandProcessor(harness.commandRepository, sink, {
      baseDelayMs: 30_000,
    });

    const first = await processor.process({
      organizationId,
      commandId,
      now: "2026-09-19T00:01:00.000Z",
    });
    assert(Result.isSuccess(first));
    expect(first.value.status).toBe("pending");
    const retrying = harness.commandRepository.records.get(commandId);
    expect(retrying).toMatchObject({ attemptCount: 1, nextAttemptAt: "2026-09-19T00:01:30.000Z" });

    // backoff期間中のsweepは配送しない
    const early = await harness.commandRepository.listDuePending({
      now: "2026-09-19T00:01:10.000Z",
      limit: 10,
    });
    assert(Result.isSuccess(early));
    expect(early.value).toHaveLength(0);
    const skipped = await processor.process({
      organizationId,
      commandId,
      now: "2026-09-19T00:01:10.000Z",
    });
    assert(Result.isSuccess(skipped));
    expect(sink.calls).toBe(1);

    const due = await harness.commandRepository.listDuePending({
      now: "2026-09-19T00:01:30.000Z",
      limit: 10,
    });
    assert(Result.isSuccess(due));
    expect(due.value.map((record) => record.command.id)).toEqual([commandId]);
    const second = await processor.process({
      organizationId,
      commandId,
      now: "2026-09-19T00:01:30.000Z",
    });
    assert(Result.isSuccess(second));
    expect(second.value.status).toBe("delivered");
    expect(sink.calls).toBe(2);
  });

  it("#88: retry上限に達したretriable失敗だけをfailedで確定する", async () => {
    const harness = createHarness();
    const commandId = await acceptDecision(harness, "retry-limit");
    const sink = new FakeSink();
    sink.results = [
      Result.fail(new PublicApiRepositoryError("decision_workflow_send_failed", true, "timeout")),
      Result.fail(new PublicApiRepositoryError("decision_workflow_send_failed", true, "timeout")),
    ];
    const processor = new ApprovalDecisionCommandProcessor(harness.commandRepository, sink, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });
    const first = await processor.process({
      organizationId,
      commandId,
      now: "2026-09-19T00:02:00.000Z",
    });
    assert(Result.isSuccess(first));
    expect(first.value.status).toBe("pending");
    const second = await processor.process({
      organizationId,
      commandId,
      now: "2026-09-19T00:02:00.000Z",
    });
    assert(Result.isSuccess(second));
    expect(second.value).toMatchObject({
      status: "failed",
      error: { code: "decision_workflow_send_failed", status: 503 },
    });
    expect(second.value.error?.detail).not.toContain("timeout");
  });

  it("#88: 並行してprocessしても配送は1回で、最終状態は後退しない", async () => {
    const harness = createHarness();
    const commandId = await acceptDecision(harness, "concurrent");
    const sink = new FakeSink();
    sink.results = [Result.succeed({ type: "delivered" }), Result.succeed({ type: "delivered" })];
    const processor = new ApprovalDecisionCommandProcessor(harness.commandRepository, sink);

    const [inline, sweep] = await Promise.all([
      processor.process({ organizationId, commandId, now: "2026-09-19T00:03:00.000Z" }),
      processor.process({ organizationId, commandId, now: "2026-09-19T00:03:00.000Z" }),
    ]);
    assert(Result.isSuccess(inline));
    assert(Result.isSuccess(sweep));
    expect(sink.calls).toBe(1);

    // Workflowが受理をapplied（CAS）で書き戻した後は、processorが後から状態を戻せない
    const resolved = await harness.commandRepository.transition({
      organizationId,
      commandId,
      from: ["pending", "delivered"],
      to: "applied",
      appliedAt: "2026-09-19T00:03:01.000Z",
    });
    assert(Result.isSuccess(resolved));
    expect(resolved.value.type).toBe("updated");
    const late = await harness.commandRepository.transition({
      organizationId,
      commandId,
      from: ["pending"],
      to: "failed",
    });
    assert(Result.isSuccess(late));
    expect(late.value).toMatchObject({ type: "stale", record: { command: { status: "applied" } } });
    const again = await processor.process({
      organizationId,
      commandId,
      now: "2026-09-19T00:04:00.000Z",
    });
    assert(Result.isSuccess(again));
    expect(again.value.status).toBe("applied");
    expect(sink.calls).toBe(1);
  });
});
