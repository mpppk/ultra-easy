import { Result } from "@praha/byethrow";

import { EffectHandlerError } from "@app/workflow-application";
import type { LlmProvider } from "@app/workflow-application";

/** Workers AI binding（`env.AI`）の最小interface。 */
export type WorkersAiBinding = {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
};

const runModel = Result.fn({
  try: async (input: {
    ai: WorkersAiBinding;
    model: string;
    inputs: Record<string, unknown>;
  }): Promise<unknown> => input.ai.run(input.model, input.inputs),
  catch: (error): EffectHandlerError => {
    const message = error instanceof Error ? error.message : "Workers AIの呼び出しに失敗しました";
    // Workers AIのerrorは「<4桁code>: message」形式。codeだけをerror codeへ載せる（messageはlogへ出さない）。
    const code = /\b(\d{4})\b/.exec(message)?.[1];
    // 5xxxは入力 / model起因（再試行しても成功しない）ためfail-closedに、それ以外は一時障害として再試行する。
    return new EffectHandlerError(
      code ? `workers_ai_${code}` : "llm_provider_unavailable",
      !code?.startsWith("5"),
      message,
    );
  },
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Workers AIをLLM Gatewayのproviderとして使う。bindingはhost（Worker）だけが持ち、
 * sandboxやworkflow stateには渡らない。
 */
export class WorkersAiLlmProvider implements LlmProvider {
  readonly name = "workers-ai";

  constructor(private readonly ai: WorkersAiBinding) {}

  async complete(input: {
    model: string;
    system?: string;
    prompt: string;
    maxOutputTokens: number;
  }): ReturnType<LlmProvider["complete"]> {
    const ran = await runModel({
      ai: this.ai,
      model: input.model,
      inputs: {
        messages: [
          ...(input.system !== undefined ? [{ role: "system", content: input.system }] : []),
          { role: "user", content: input.prompt },
        ],
        max_tokens: input.maxOutputTokens,
      },
    });
    if (Result.isFailure(ran)) return ran;
    const output = record(ran.value);
    const response = output["response"];
    const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
    const usage = record(output["usage"]);
    return Result.succeed({
      text,
      ...(typeof usage["prompt_tokens"] === "number"
        ? { inputTokens: usage["prompt_tokens"] }
        : {}),
      ...(typeof usage["completion_tokens"] === "number"
        ? { outputTokens: usage["completion_tokens"] }
        : {}),
    });
  }
}
