import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { parseProgramResult } from "./program.ts";

function yielded(effect: unknown) {
  return parseProgramResult({ type: "yield", state: {}, effect });
}

describe("Human Input Program effect", () => {
  it("keeps prompt-only definitions compatible", () => {
    const parsed = yielded({ type: "human_input", prompt: "Continue?" });
    expect(Result.isSuccess(parsed) && parsed.value).toEqual({
      type: "yield",
      state: {},
      effect: { type: "human_input", prompt: "Continue?" },
    });
  });

  it("preserves governed assignee, options, answer schema and display fields", () => {
    const effect = {
      type: "human_input",
      prompt: "Review page",
      assignee: { type: "user", id: "user:bob" },
      options: ["keep", "archive"],
      answerSchema: { type: "string", enum: ["keep", "archive"] },
      subject: { type: "knowledge_page", id: "page:one", title: "Page One" },
      analysis: "Possibly stale",
    };
    const parsed = yielded(effect);
    expect(Result.isSuccess(parsed) && parsed.value).toEqual({ type: "yield", state: {}, effect });
  });

  it("rejects invalid assignees, options, and nested schemas", () => {
    for (const extra of [
      { assignee: { type: "service", id: "service:bot" } },
      { options: ["keep", "keep"] },
      { answerSchema: { type: "array", items: { type: "unknown" } } },
      { options: ["keep"], answerSchema: { type: "string", enum: ["archive"] } },
    ]) {
      expect(Result.isFailure(yielded({ type: "human_input", prompt: "Review", ...extra }))).toBe(
        true,
      );
    }
  });
});
