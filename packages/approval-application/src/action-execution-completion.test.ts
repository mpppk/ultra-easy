import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { foldActionRequestStatus } from "@app/approval-core";
import {
  InMemoryActionAuditStore,
  InMemoryAsyncActionExecutionStore,
} from "@app/approval-core/testing";
import type {
  Action,
  ActionDefinition,
  ActionDefinitionKey,
  ActionExecutionDispatch,
  ActionExecutionRequest,
  ActionExecutor,
  ActionFingerprint,
  ActionRequestId,
  ExecutorKey,
  MaterializedApprovalPlan,
  OrganizationId,
  SchemaKey,
  UserId,
} from "@app/approval-core";

import { ActionExecutionCompletionService } from "./action-execution-completion.ts";
import { ActionRequestApplicationService } from "./action-request-service.ts";
import type { TrustedActionRequestContext } from "./action-request-service.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:async");
const alice = branded<UserId>("user:alice");
const NOW = "2026-09-25T00:00:00.000Z";
const LATER = "2026-09-25T01:00:00.000Z";

const action: Action = {
  type: branded("employee.onboard"),
  resource: { type: branded("employee"), id: branded("EMP-1") },
  input: { name: "Bob" },
};

const trustedContext: TrustedActionRequestContext = {
  actor: { type: "user", id: alice },
  authority: { principal: { type: "user", id: alice } },
  origin: { type: "api" },
  organization: { id: organizationId },
  now: NOW,
};

const schema = {
  "~standard": {
    version: 1,
    vendor: "async-test",
    validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

const definition: ActionDefinition = {
  key: branded<ActionDefinitionKey>("employee-onboard"),
  version: 1,
  actionType: action.type,
  inputSchema: { key: branded<SchemaKey>("employee-onboard-input"), version: 1 },
  executorKey: branded<ExecutorKey>("workflow"),
};

/** WorkflowRunを開始して`accepted`を返すasync executorの代役。 */
class AcceptingExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  readonly dispatched: ActionExecutionRequest[] = [];

  async execute() {
    return Result.succeed({ status: "succeeded" as const });
  }

  async dispatch(request: ActionExecutionRequest) {
    this.dispatched.push(request);
    return Result.succeed<ActionExecutionDispatch>({
      type: "accepted",
      executionRef: `run:${String(request.actionRequestId)}`,
    });
  }
}

function harness(options: { withAsyncStore?: boolean } = {}) {
  const audit = new InMemoryActionAuditStore();
  const asyncExecutions = new InMemoryAsyncActionExecutionStore(audit);
  const executor = new AcceptingExecutor();
  const saved: MaterializedApprovalPlan[] = [];
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: { resolve: async () => Result.succeed(definition) },
    schemaResolver: { resolve: async () => Result.succeed(schema) },
    policyBindingResolver: { resolve: async () => Result.succeed([]) },
    authorizer: {
      check: async (input) =>
        Result.succeed({
          type: "allow" as const,
          evidence: { evaluatedAt: input.evaluatedAt, consistency: input.consistency },
        }),
    },
    executor,
    planRepository: {
      save: async (plan) => {
        saved.push(plan);
        return { type: "created" as const };
      },
      load: async () => ({ type: "not_found" as const }),
    },
    eventRepository: audit,
    resultRepository: audit,
    ...(options.withAsyncStore === false ? {} : { asyncExecutions }),
    workflowStarter: { start: async () => Result.fail(new Error("unused") as never) },
    idGenerator: { next: () => branded<ActionRequestId>("action:async-1") },
  });
  const completion = new ActionExecutionCompletionService({
    asyncExecutions,
    results: audit,
    events: audit,
  });
  const status = () =>
    foldActionRequestStatus(
      audit.events
        .filter((record) => String(record.event.actionRequestId) === "action:async-1")
        .map((record) => record.event),
      { approvalRequired: false },
    );
  return { audit, asyncExecutions, executor, service, completion, saved, status };
}

async function submitAccepted(h: ReturnType<typeof harness>) {
  const submitted = await h.service.submit({ action, trustedContext });
  assert(Result.isSuccess(submitted) && submitted.value.type === "accepted");
  const record = await h.asyncExecutions.load({
    organizationId,
    actionRequestId: branded<ActionRequestId>("action:async-1"),
  });
  assert(Result.isSuccess(record) && record.value);
  return { view: submitted.value.view, record: record.value };
}

function completionInput(
  record: { actionFingerprint: ActionFingerprint; executionRef: string; idempotencyKey: string },
  overrides: Partial<Parameters<ActionExecutionCompletionService["complete"]>[0]> = {},
): Parameters<ActionExecutionCompletionService["complete"]>[0] {
  return {
    organizationId,
    actionRequestId: branded<ActionRequestId>("action:async-1"),
    actionFingerprint: record.actionFingerprint,
    executionRef: record.executionRef,
    idempotencyKey: record.idempotencyKey,
    completion: { status: "executed", output: { employeeId: "EMP-1" } },
    completedAt: LATER,
    ...overrides,
  };
}

describe("async Action execution contract (#165)", () => {
  it("accepted keeps the ActionRequest executing until a trusted completion arrives", async () => {
    const h = harness();
    const { view, record } = await submitAccepted(h);
    expect(view.status).toBe("executing");
    expect(view.result).toBeUndefined();
    expect(record).toMatchObject({ status: "accepted", executionRef: "run:action:async-1" });
    expect(h.audit.events.map((event) => event.event.type)).toEqual(
      expect.arrayContaining(["action.execution_started", "action.execution_accepted"]),
    );
    expect(h.audit.events.map((event) => event.event.type)).not.toContain("action.completed");
    expect(
      h.audit.result({ organizationId, actionRequestId: record.actionRequestId }),
    ).toBeUndefined();

    // process memoryを持たない待機の後、trusted completionで終端する。
    const completed = await h.completion.complete(completionInput(record));
    expect(Result.isSuccess(completed) && completed.value.type).toBe("completed");
    expect(h.status()).toBe("executed");
    expect(
      h.audit.result({ organizationId, actionRequestId: record.actionRequestId }),
    ).toMatchObject({
      status: "executed",
      result: { status: "succeeded", output: { employeeId: "EMP-1" } },
      idempotencyKey: record.idempotencyKey,
    });
  });

  it("completion replay is idempotent and conflicting completion is rejected and audited", async () => {
    const h = harness();
    const { record } = await submitAccepted(h);
    await h.completion.complete(completionInput(record));
    const replay = await h.completion.complete(completionInput(record));
    expect(Result.isSuccess(replay) && replay.value.type).toBe("replayed");

    const conflicting = await h.completion.complete(
      completionInput(record, {
        completion: { status: "execution_failed", code: "boom", message: "boom" },
      }),
    );
    expect(Result.isFailure(conflicting) && conflicting.error.code).toBe("completion_conflict");
    expect(h.status()).toBe("executed");
    expect(
      h.audit.events.some(
        (event) =>
          event.event.type === "action.execution_completion_rejected" &&
          event.event.code === "completion_conflict",
      ),
    ).toBe(true);
  });

  it("rejects spoofed / stale completions bound to another execution", async () => {
    const h = harness();
    const { record } = await submitAccepted(h);
    for (const overrides of [
      { executionRef: "run:other" },
      { actionFingerprint: branded<ActionFingerprint>("sha256:other") },
      { idempotencyKey: "ue:v1:other" },
    ]) {
      const rejected = await h.completion.complete(completionInput(record, overrides));
      expect(Result.isFailure(rejected) && rejected.error.code).toBe("completion_binding_mismatch");
    }
    const unknown = await h.completion.complete(
      completionInput(record, { actionRequestId: branded<ActionRequestId>("action:never") }),
    );
    expect(Result.isFailure(unknown) && unknown.error.code).toBe("execution_not_accepted");
    expect(h.status()).toBe("executing");
  });

  it("cancel request and completion race: the first terminal completion wins", async () => {
    const h = harness();
    const { record } = await submitAccepted(h);
    const cancel = await h.completion.requestCancel({
      organizationId,
      actionRequestId: record.actionRequestId,
      reason: "parent cancelled",
      requestedAt: NOW,
    });
    expect(Result.isSuccess(cancel) && cancel.value.type).toBe("cancel_requested");
    expect(h.status()).toBe("executing");

    const cancelled = await h.completion.complete(
      completionInput(record, {
        completion: {
          status: "execution_failed",
          code: "execution_cancelled",
          message: "cancelled",
        },
      }),
    );
    expect(Result.isSuccess(cancelled) && cancelled.value.type).toBe("completed");
    const late = await h.completion.complete(completionInput(record));
    expect(Result.isFailure(late) && late.error.code).toBe("completion_conflict");
    expect(h.status()).toBe("execution_failed");
    const again = await h.completion.requestCancel({
      organizationId,
      actionRequestId: record.actionRequestId,
      reason: "again",
      requestedAt: LATER,
    });
    expect(Result.isSuccess(again) && again.value.type).toBe("already_settled");
  });

  it("fails closed with execution_unknown when async acceptance cannot be recorded", async () => {
    const h = harness({ withAsyncStore: false });
    const submitted = await h.service.submit({ action, trustedContext });
    expect(Result.isFailure(submitted) && submitted.error.executionErrorCode).toBe(
      "async_execution_not_supported",
    );
    expect(h.status()).toBe("execution_unknown");
  });
});
