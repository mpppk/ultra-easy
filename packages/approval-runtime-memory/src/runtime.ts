import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import {
  applyApprovalDecision,
  expireApprovalRuntime,
  startApprovalRuntime,
} from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalDecisionReceipt,
  ApprovalInterpreterError,
  ApprovalRuntimeState,
  ApproverResolver,
  DurableRuntime,
  MaterializedApprovalPlan,
} from "@app/approval-core";

export class ApprovalRuntimeNotFoundError extends ErrorFactory({
  name: "ApprovalRuntimeNotFoundError",
  message: ({ actionRequestId }) => `Approval Runtimeが見つかりません: ${String(actionRequestId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_runtime_not_found";
    actionRequestId: ActionRequestId;
  }>(),
}) {}

export class ApprovalRuntimeAlreadyExistsError extends ErrorFactory({
  name: "ApprovalRuntimeAlreadyExistsError",
  message: ({ actionRequestId }) =>
    `Approval Runtimeは既に開始されています: ${String(actionRequestId)}`,
  fields: ErrorFactory.fields<{
    code: "approval_runtime_already_exists";
    actionRequestId: ActionRequestId;
  }>(),
}) {}

export type InMemoryApprovalRuntimeError =
  | ApprovalRuntimeNotFoundError
  | ApprovalRuntimeAlreadyExistsError
  | ApprovalInterpreterError;

type RuntimeRecord = {
  plan: MaterializedApprovalPlan;
  state: ApprovalRuntimeState;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryApprovalRuntime implements DurableRuntime<InMemoryApprovalRuntimeError> {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  constructor(
    private readonly resolver: ApproverResolver,
    private readonly supportedInterpreterSemanticsVersions: readonly number[] = [1],
  ) {}

  async start(input: {
    plan: MaterializedApprovalPlan;
    startedAt: string;
  }): Result.ResultAsync<ApprovalRuntimeState, InMemoryApprovalRuntimeError> {
    const key = String(input.plan.actionRequestId);
    if (this.runtimes.has(key)) {
      return Result.fail(
        new ApprovalRuntimeAlreadyExistsError({
          code: "approval_runtime_already_exists",
          actionRequestId: input.plan.actionRequestId,
        }),
      );
    }
    const started = await startApprovalRuntime({
      plan: input.plan,
      resolver: this.resolver,
      startedAt: input.startedAt,
      supportedInterpreterSemanticsVersions: this.supportedInterpreterSemanticsVersions,
    });
    if (Result.isFailure(started)) return started;
    this.runtimes.set(key, { plan: clone(input.plan), state: clone(started.value) });
    return Result.succeed(clone(started.value));
  }

  async decide(input: {
    actionRequestId: ActionRequestId;
    event: ApprovalDecisionEvent;
  }): Result.ResultAsync<ApprovalDecisionReceipt, InMemoryApprovalRuntimeError> {
    const record = this.runtimes.get(String(input.actionRequestId));
    if (!record) {
      return Result.fail(
        new ApprovalRuntimeNotFoundError({
          code: "approval_runtime_not_found",
          actionRequestId: input.actionRequestId,
        }),
      );
    }
    const decided = await applyApprovalDecision({
      plan: record.plan,
      resolver: this.resolver,
      state: record.state,
      event: input.event,
    });
    if (Result.isFailure(decided)) return decided;
    record.state = clone(decided.value.state);
    return Result.succeed({ state: clone(record.state), duplicate: decided.value.duplicate });
  }

  async advanceTime(input: {
    actionRequestId: ActionRequestId;
    now: string;
  }): Result.ResultAsync<ApprovalRuntimeState, InMemoryApprovalRuntimeError> {
    const record = this.runtimes.get(String(input.actionRequestId));
    if (!record) {
      return Result.fail(
        new ApprovalRuntimeNotFoundError({
          code: "approval_runtime_not_found",
          actionRequestId: input.actionRequestId,
        }),
      );
    }
    const advanced = await expireApprovalRuntime({
      plan: record.plan,
      resolver: this.resolver,
      state: record.state,
      now: input.now,
    });
    if (Result.isFailure(advanced)) return advanced;
    record.state = clone(advanced.value);
    return Result.succeed(clone(record.state));
  }

  load(
    actionRequestId: ActionRequestId,
  ): Result.ResultAsync<ApprovalRuntimeState | null, InMemoryApprovalRuntimeError> {
    const record = this.runtimes.get(String(actionRequestId));
    return Promise.resolve(Result.succeed(record ? clone(record.state) : null));
  }
}
