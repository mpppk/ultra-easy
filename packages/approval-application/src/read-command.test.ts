import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

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
  ApprovalDecisionSink,
  ApprovalReadRepository,
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

  listPending(input: { organizationId: OrganizationId; limit: number }) {
    const records = [...this.records.values()]
      .filter(
        (record) =>
          record.command.organizationId === String(input.organizationId) &&
          record.command.status === "pending",
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
    return Promise.resolve(Result.succeed(records));
  }

  update(input: {
    organizationId: OrganizationId;
    commandId: string;
    status: "applied" | "rejected" | "failed";
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
    const updated: ApprovalCommandRecord = {
      ...current,
      command: {
        ...current.command,
        status: input.status,
        ...(input.appliedAt !== undefined ? { appliedAt: input.appliedAt } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
    };
    this.records.set(input.commandId, structuredClone(updated));
    return Promise.resolve(Result.succeed(structuredClone(updated)));
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

  apply() {
    this.calls += 1;
    return Promise.resolve(Result.succeed({ type: "applied" as const }));
  }
}

function createHarness() {
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
      appliedAt: "2026-09-19T00:01:00.000Z",
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

  it("AC-M6-006: 5xxもcomplete記録し、同key retryをin_progressで詰まらせない", async () => {
    const harness = createHarness();
    let calls = 0;
    const failing = createPublicHttpApi({
      actionRequestApi: {
        async fetch() {
          calls += 1;
          return new Response(JSON.stringify({ error: "boom" }), {
            status: 503,
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
    const path = "/v1/organizations/org%3Am6/action-requests";
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-5xx",
      },
      body: JSON.stringify({
        action: {
          type: "ticket.priority.change",
          resource: { type: "ticket", id: "TICKET-1" },
          input: { priority: "normal" },
        },
      }),
    } satisfies RequestInit;

    const first = await failing.fetch(request(path, init));
    const second = await failing.fetch(request(path, init));

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toEqual({ error: "boom" });
    expect(calls).toBe(1);
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
      appliedAt: "2026-09-19T00:10:00.000Z",
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
});
