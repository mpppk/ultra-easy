import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  ActionExecutorError,
  createActionExecutionIdempotencyKey,
} from "./action-execution.ts";
import type { ActionFingerprint, ActionRequestId } from "./domain/brand.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

describe("ActionExecutor contract", () => {
  it("actionRequestIdとactionFingerprintから安定したidempotency keyを生成する", () => {
    const actionRequestId = branded<ActionRequestId>("action-request:contract");
    const actionFingerprint = branded<ActionFingerprint>("sha256:action-contract");

    expect(createActionExecutionIdempotencyKey(actionRequestId, actionFingerprint)).toBe(
      "action-request:contract:sha256:action-contract",
    );
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
