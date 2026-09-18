import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  ActionAuthorizationCheckFailedError,
  AuthorizationProviderError,
  executeActionRequest,
} from "@app/approval-core";
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionFingerprint,
  ActionRequest,
  ActionRequestId,
  ActionAuthorizer,
  AuthorizationConsistency,
  AuthorizationDecision,
  ActionDefinitionKey,
  ExecutorKey,
  JsonObject,
  MaterializedActionSnapshot,
  SchemaKey,
} from "@app/approval-core";
import { createHumanActionRequest } from "@app/approval-core/testing";

function branded<T extends string>(value: string): T {
  return value as T;
}

const actionRequestId = branded<ActionRequestId>("action-request:m5");
const actionFingerprint = branded<ActionFingerprint>("sha256:action-m5");

function materializedAction(request: ActionRequest): MaterializedActionSnapshot {
  return {
    definition: {
      key: branded<ActionDefinitionKey>("ticket-priority-change"),
      version: 1,
      actionType: request.action.type,
      inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
      executorKey: branded<ExecutorKey>("ticket-executor"),
    },
    type: request.action.type,
    resource: request.action.resource,
    input: request.action.input as JsonObject,
  };
}

class FakeAuthorizer implements ActionAuthorizer {
  readonly calls: AuthorizationConsistency[] = [];

  constructor(private readonly mode: "allow" | "deny" | "error") {}

  async check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: AuthorizationConsistency;
  }) {
    this.calls.push(input.consistency);
    if (this.mode === "error") {
      return Result.fail(
        new AuthorizationProviderError({
          provider: "fake",
          code: "provider_timeout",
          retriable: true,
          detail: "provider timed out",
        }),
      );
    }

    const decision: AuthorizationDecision =
      this.mode === "allow"
        ? {
            type: "allow",
            evidence: {
              evaluatedAt: input.evaluatedAt,
              provider: "fake",
              consistency: input.consistency,
            },
          }
        : {
            type: "deny",
            code: "permission_revoked",
            reason: "authority was revoked",
          };
    return Result.succeed(decision);
  }
}

class CapturingExecutor implements ActionExecutor {
  readonly requests: ActionExecutionRequest[] = [];

  async execute(request: ActionExecutionRequest) {
    this.requests.push(request);
    const result: ActionExecutionResult = {
      status: "succeeded",
      output: { ok: true },
    };
    return Result.succeed(result);
  }
}

function executionInput(authorizer: ActionAuthorizer, executor: ActionExecutor) {
  const request = createHumanActionRequest();
  return {
    authorizer,
    executor,
    actionRequestId,
    request,
    actionFingerprint,
    action: materializedAction(request),
    evaluatedAt: "2026-09-18T12:00:00.000Z",
  };
}

describe("M5 Safe Action Execution", () => {
  it("AC-M5-001: approval不要でも実行直前にhigher consistencyでAuthorizationする", async () => {
    const authorizer = new FakeAuthorizer("allow");
    const executor = new CapturingExecutor();

    const result = await executeActionRequest(executionInput(authorizer, executor));

    assert(Result.isSuccess(result));
    expect(result.value.type).toBe("executed");
    expect(authorizer.calls).toEqual(["higher_consistency"]);
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.authorizationEvidence.consistency).toBe("higher_consistency");
  });

  it("AC-M5-002: 承認待ち中にauthorityが失効していればExecutorを呼ばない", async () => {
    const authorizer = new FakeAuthorizer("deny");
    const executor = new CapturingExecutor();

    const result = await executeActionRequest(executionInput(authorizer, executor));

    assert(Result.isSuccess(result));
    expect(result.value).toEqual({
      type: "authorization_revoked",
      code: "permission_revoked",
      reason: "authority was revoked",
    });
    expect(executor.requests).toHaveLength(0);
  });

  it("AC-M5-003: Authorization provider errorをdenyと区別してretry可能なfailureにする", async () => {
    const authorizer = new FakeAuthorizer("error");
    const executor = new CapturingExecutor();

    const result = await executeActionRequest(executionInput(authorizer, executor));

    assert(Result.isFailure(result));
    expect(result.error).toBeInstanceOf(ActionAuthorizationCheckFailedError);
    expect(result.error.name).toBe("ActionAuthorizationCheckFailedError");
    expect(result.error.code).toBe("authorization_check_failed");
    expect(result.error.retriable).toBe(true);
    expect(result.error.providerCode).toBe("provider_timeout");
    expect(executor.requests).toHaveLength(0);
  });

  it("AC-M5-004: retryしても同一ActionRequestには同じidempotency keyを渡す", async () => {
    const authorizer = new FakeAuthorizer("allow");
    const executor = new CapturingExecutor();
    const input = executionInput(authorizer, executor);

    const first = await executeActionRequest(input);
    const second = await executeActionRequest(input);

    assert(Result.isSuccess(first));
    assert(Result.isSuccess(second));
    expect(executor.requests).toHaveLength(2);
    expect(executor.requests[0]?.idempotencyKey).toBe("action-request:m5:sha256:action-m5");
    expect(executor.requests[1]?.idempotencyKey).toBe(executor.requests[0]?.idempotencyKey);
  });
});
