import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  ActionAuthorizationCheckFailedError,
  AuthorizationProviderError,
  executeActionRequest,
  validateApprovalBindingForExecution,
} from "@app/approval-core";
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionFingerprint,
  ActionRequest,
  ApprovalBindingFingerprint,
  ApprovalPlanChecksum,
  ApprovalRuntimeState,
  ActionRequestId,
  ActionAuthorizer,
  AuthorizationConsistency,
  AuthorizationDecision,
  ActionDefinitionKey,
  ExecutorKey,
  JsonObject,
  MaterializedActionSnapshot,
  MaterializedApprovalPlan,
  OrganizationId,
  SchemaKey,
} from "@app/approval-core";
import { createHumanActionRequest } from "@app/approval-core/testing";

function branded<T extends string>(value: string): T {
  return value as T;
}

const actionRequestId = branded<ActionRequestId>("action-request:m5");
const actionFingerprint = branded<ActionFingerprint>("sha256:action-m5");
const organizationId = branded<OrganizationId>("organization:m5");

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
  readonly guaranteeLevel = "best_effort_at_most_once" as const;

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
    organizationId,
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
    assert(result.error instanceof ActionAuthorizationCheckFailedError);
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
    expect(executor.requests[0]?.idempotencyKey).toBe(
      "ue:v1:organization%3Am5:action-request%3Am5:sha256%3Aaction-m5",
    );
    expect(executor.requests[1]?.idempotencyKey).toBe(executor.requests[0]?.idempotencyKey);
  });

  it("AC-M5-007: Decision bindingと実行対象が一致しなければ実行対象として扱わない", () => {
    const currentBinding = branded<ApprovalBindingFingerprint>("sha256:binding-current");
    const plan = {
      actionRequestId,
      approvalPlanChecksum: branded<ApprovalPlanChecksum>("sha256:plan-current"),
      approvalBindingFingerprint: currentBinding,
      flow: { type: "approval" },
    } as unknown as MaterializedApprovalPlan;
    const state = {
      actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
      status: "approved",
      tasks: [
        {
          decisions: [
            {
              approvalBindingFingerprint:
                branded<ApprovalBindingFingerprint>("sha256:binding-stale"),
            },
          ],
        },
      ],
    } as unknown as ApprovalRuntimeState;

    const result = validateApprovalBindingForExecution({ plan, state });

    assert(Result.isFailure(result));
    expect(result.error.code).toBe("approval_binding_mismatch");
    expect(result.error.expected).toBe(currentBinding);
    expect(result.error.actual).toBe("sha256:binding-stale");
  });

  it("AC-M5-008: best-effort Executorをexactly-onceとして扱わない", async () => {
    const authorizer = new FakeAuthorizer("allow");
    const executor = new CapturingExecutor();
    const input = executionInput(authorizer, executor);

    const first = await executeActionRequest(input);
    const second = await executeActionRequest(input);

    assert(Result.isSuccess(first));
    assert(Result.isSuccess(second));
    assert(first.value.type === "executed");
    assert(second.value.type === "executed");
    expect(first.value.guaranteeLevel).toBe("best_effort_at_most_once");
    expect(second.value.guaranteeLevel).toBe("best_effort_at_most_once");
    expect(executor.requests).toHaveLength(2);
  });

  it("AC-M7-001: executor idempotency keyはorganization境界で衝突しない", async () => {
    const authorizer = new FakeAuthorizer("allow");
    const executor = new CapturingExecutor();
    const input = executionInput(authorizer, executor);

    await executeActionRequest(input);
    await executeActionRequest({
      ...input,
      organizationId: branded<OrganizationId>("organization:other"),
    });

    expect(executor.requests).toHaveLength(2);
    expect(executor.requests[0]?.idempotencyKey).not.toBe(executor.requests[1]?.idempotencyKey);
  });
});
