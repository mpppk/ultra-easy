import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { parseForceCancelBody } from "./preview-force-cancel.ts";

describe("parseForceCancelBody", () => {
  it("reasonとactorを受け付ける", () => {
    const parsed = parseForceCancelBody({
      reason: "stuck workflow recovery drill",
      actor: { type: "user", id: "user:operator" },
    });
    expect(Result.isFailure(parsed)).toBe(false);
    if (Result.isFailure(parsed)) return;
    expect(parsed.value).toEqual({
      reason: "stuck workflow recovery drill",
      actor: { type: "user", id: "user:operator" },
    });
  });

  it("actor省略時はpreview operatorを補完する", () => {
    const parsed = parseForceCancelBody({ reason: "stuck workflow recovery drill" });
    expect(Result.isFailure(parsed)).toBe(false);
    if (Result.isFailure(parsed)) return;
    expect(parsed.value.actor).toEqual({ type: "user", id: "user:preview-operator" });
  });

  it("空のreasonを拒否する", () => {
    for (const body of [{}, { reason: "" }, { reason: "   " }, null, []]) {
      const parsed = parseForceCancelBody(body);
      expect(Result.isFailure(parsed)).toBe(true);
      if (Result.isFailure(parsed)) expect(parsed.error.code).toBe("invalid_reason");
    }
  });

  it("不正なactorを拒否する", () => {
    for (const actor of [
      { type: "admin", id: "user:operator" },
      { type: "user", id: "" },
      "user:operator",
    ]) {
      const parsed = parseForceCancelBody({ reason: "drill", actor });
      expect(Result.isFailure(parsed)).toBe(true);
      if (Result.isFailure(parsed)) expect(parsed.error.code).toBe("invalid_actor");
    }
  });
});
