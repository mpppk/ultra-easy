import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { WorkersAiLlmProvider } from "./workers-ai.ts";

describe("Workers AI LLM provider (#161)", () => {
  it("maps messages / max tokens and usage", async () => {
    const calls: unknown[] = [];
    const provider = new WorkersAiLlmProvider({
      async run(model, inputs) {
        calls.push({ model, inputs });
        return { response: "hello", usage: { prompt_tokens: 7, completion_tokens: 2 } };
      },
    });
    const result = await provider.complete({
      model: "@cf/test",
      system: "sys",
      prompt: "hi",
      maxOutputTokens: 16,
    });
    expect(result).toEqual(Result.succeed({ text: "hello", inputTokens: 7, outputTokens: 2 }));
    expect(calls).toEqual([
      {
        model: "@cf/test",
        inputs: {
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
          ],
          max_tokens: 16,
        },
      },
    ]);
  });

  it("reports provider failures as retriable errors", async () => {
    const provider = new WorkersAiLlmProvider({
      run: async () => Promise.reject(new Error("rate limited")),
    });
    const result = await provider.complete({ model: "m", prompt: "p", maxOutputTokens: 1 });
    expect(Result.isFailure(result) && result.error).toMatchObject({
      code: "llm_provider_unavailable",
      retriable: true,
    });
  });
});
