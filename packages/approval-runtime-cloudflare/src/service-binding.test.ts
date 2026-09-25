import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { ActionExecutorRegistry } from "@app/approval-core";
import type {
  ActionExecutionRequest,
  ActionFingerprint,
  ActionRequestId,
  ExecutorKey,
  OrganizationId,
} from "@app/approval-core";
import { createHumanActionRequest } from "@app/approval-core/testing";

import {
  ServiceBindingActionAuthorizer,
  ServiceBindingActionExecutor,
  serveActionExecutorRegistry,
  type ActionServiceBinding,
} from "./service-binding.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("organization:service-binding");
const actionRequestId = branded<ActionRequestId>("action:service-binding");

class CaptureBinding implements ActionServiceBinding {
  readonly requests: Request[] = [];

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    if (new URL(request.url).pathname === "/check") {
      return Response.json({
        type: "allow",
        evidence: { provider: "capture-binding" },
      });
    }
    return Response.json({ status: "succeeded", output: { ok: true } });
  }
}

describe("service-binding correlation", () => {
  it("AC-M7-007: Workflow→ActionAuthorizerへActionRequest correlation headerを伝播する", async () => {
    const binding = new CaptureBinding();
    const authorizer = new ServiceBindingActionAuthorizer(binding, organizationId, actionRequestId);

    const result = await authorizer.check({
      request: createHumanActionRequest(),
      evaluatedAt: "2026-09-20T00:00:00.000Z",
      consistency: "higher_consistency",
    });
    assert(Result.isSuccess(result));

    const request = binding.requests[0]!;
    expect(request.headers.get("x-ue-organization-id")).toBe(String(organizationId));
    expect(request.headers.get("x-ue-action-request-id")).toBe(String(actionRequestId));
    expect(request.headers.get("x-ue-correlation-id")).toBe(String(actionRequestId));
  });

  it("AC-M7-007: Workflow→ActionExecutorへ同じActionRequest correlation headerを伝播する", async () => {
    const binding = new CaptureBinding();
    const executor = new ServiceBindingActionExecutor(
      binding,
      branded<ExecutorKey>("executor:ticket"),
    );
    const executionRequest = {
      organizationId,
      actionRequestId,
      actionFingerprint: branded<ActionFingerprint>("sha256:service-binding"),
      idempotencyKey: "idem:service-binding",
      action: {} as ActionExecutionRequest["action"],
      authorizationEvidence: {
        evaluatedAt: "2026-09-20T00:00:00.000Z",
        consistency: "higher_consistency" as const,
      },
    } satisfies ActionExecutionRequest;

    const result = await executor.execute(executionRequest);
    assert(Result.isSuccess(result));

    const request = binding.requests[0]!;
    expect(request.headers.get("x-ue-organization-id")).toBe(String(organizationId));
    expect(request.headers.get("x-ue-action-request-id")).toBe(String(actionRequestId));
    expect(request.headers.get("x-ue-correlation-id")).toBe(String(actionRequestId));
    expect(request.headers.get("idempotency-key")).toBe(executionRequest.idempotencyKey);
  });

  it("#165: async executorのacceptedを202でService Binding越しに往復できる", async () => {
    const registry = new ActionExecutorRegistry({
      "executor:async": {
        guaranteeLevel: "idempotent",
        execute: async () => Result.succeed({ status: "succeeded" as const }),
        dispatch: async (request: ActionExecutionRequest) =>
          Result.succeed({
            type: "accepted" as const,
            executionRef: `job:${String(request.actionRequestId)}`,
          }),
      },
      "executor:sync": {
        guaranteeLevel: "idempotent",
        execute: async () => Result.succeed({ status: "succeeded" as const, output: { ok: 1 } }),
      },
    });
    const binding: ActionServiceBinding = {
      fetch: (request) => serveActionExecutorRegistry(request, registry),
    };
    const request = (executorKey: string) =>
      ({
        organizationId,
        actionRequestId,
        actionFingerprint: branded<ActionFingerprint>("sha256:service-binding"),
        idempotencyKey: "idem:service-binding",
        action: { definition: { executorKey } } as ActionExecutionRequest["action"],
        authorizationEvidence: {
          evaluatedAt: "2026-09-20T00:00:00.000Z",
          consistency: "higher_consistency" as const,
        },
      }) satisfies ActionExecutionRequest;

    const asyncExecutor = new ServiceBindingActionExecutor(
      binding,
      branded<ExecutorKey>("executor:async"),
    );
    expect(await asyncExecutor.dispatch(request("executor:async"))).toEqual(
      Result.succeed({ type: "accepted", executionRef: `job:${String(actionRequestId)}` }),
    );
    // accepted結果はexecute（同期contract）では成功扱いにしない。
    const legacy = await asyncExecutor.execute(request("executor:async"));
    expect(Result.isFailure(legacy) && legacy.error.code).toBe("async_execution_requires_dispatch");

    const syncExecutor = new ServiceBindingActionExecutor(
      binding,
      branded<ExecutorKey>("executor:sync"),
    );
    expect(await syncExecutor.dispatch(request("executor:sync"))).toEqual(
      Result.succeed({ type: "completed", result: { status: "succeeded", output: { ok: 1 } } }),
    );
  });
});
