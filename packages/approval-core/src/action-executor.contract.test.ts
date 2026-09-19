import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { ActionExecutorError, createActionExecutionIdempotencyKey } from "./action-execution.ts";
import type { ActionFingerprint, ActionRequestId, OrganizationId } from "./domain/brand.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

describe("ActionExecutor contract", () => {
  it("actionRequestIdとactionFingerprintから安定したidempotency keyを生成する", () => {
    const organizationId = branded<OrganizationId>("organization:contract");
    const actionRequestId = branded<ActionRequestId>("action-request:contract");
    const actionFingerprint = branded<ActionFingerprint>("sha256:action-contract");

    expect(
      createActionExecutionIdempotencyKey(organizationId, actionRequestId, actionFingerprint),
    ).toBe("ue:v1:organization%3Acontract:action-request%3Acontract:sha256%3Aaction-contract");
  });

  it("Executor failureをname/code/retriableで識別できる", () => {
    const error = new ActionExecutorError({
      code: "upstream_timeout",
      retriable: true,
      detail: "upstream timed out",
    });
    const result = Result.fail(error);

    expect(Result.isFailure(result)).toBe(true);
    expect(error.name).toBe("ActionExecutorError");
    expect(error.code).toBe("upstream_timeout");
    expect(error.retriable).toBe(true);
  });
});
