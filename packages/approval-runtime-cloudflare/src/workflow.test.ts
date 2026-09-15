import { describe, expect, it } from "vite-plus/test";

import { isWorkflowTimeoutError } from "./workflow.ts";

describe("isWorkflowTimeoutError", () => {
  it("WorkflowTimeoutError nameだけでもtimeoutとして扱う", () => {
    expect(
      isWorkflowTimeoutError({
        name: "WorkflowTimeoutError",
        message: "request failed",
      }),
    ).toBe(true);
  });

  it("RPC越しのtimeout messageだけでもtimeoutとして扱う", () => {
    expect(isWorkflowTimeoutError(new Error("Execution timed out after 60 seconds"))).toBe(true);
  });

  it("無関係なerrorはtimeoutとして扱わない", () => {
    expect(isWorkflowTimeoutError(new Error("network failure"))).toBe(false);
  });
});
