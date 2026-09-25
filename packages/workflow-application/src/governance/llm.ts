import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import type { JsonObject, JsonValue } from "@app/expression-core";
import type { EffectId, NodeRunId, WorkflowRunId } from "@app/workflow-core";

import { EffectHandlerError } from "../ports.ts";
import type {
  EffectContext,
  EffectHandler,
  EffectOutcomeReport,
  WorkflowRepositoryError,
} from "../ports.ts";
import type { ProgramCodeGenerator } from "../program.ts";
import type { CapabilityBroker } from "./capability.ts";

/**
 * LLM provider（Workers AI / 外部API等）。API key / bindingはhost側のproviderだけが持ち、
 * sandboxやworkflow stateへは渡さない。
 */
export interface LlmProvider {
  readonly name: string;
  complete(input: {
    model: string;
    system?: string;
    prompt: string;
    maxOutputTokens: number;
  }): Result.ResultAsync<
    {
      text: string;
      inputTokens?: number;
      outputTokens?: number;
      toolCalls?: { name: string; arguments: JsonObject }[];
    },
    EffectHandlerError
  >;
}

export type LlmPricing = Record<
  string,
  { inputMicroUsdPer1kTokens: number; outputMicroUsdPer1kTokens: number }
>;

export type LlmUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
};

export type LlmUsageRecord = {
  organizationId: OrganizationId;
  runId: WorkflowRunId;
  nodeRunId: NodeRunId;
  effectId: EffectId;
  model: string;
  status: "reserved" | "completed" | "denied";
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  code?: string;
  output?: JsonValue;
  createdAt: string;
};

/**
 * LLM使用量のdurable ledger（effect IDで冪等）。budget exhaustionもdeniedとして記録し、
 * 監査・課金に使える（promptそのものは保存しない）。
 */
export interface LlmUsageLedger {
  find(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    effectId: EffectId;
  }): Result.ResultAsync<LlmUsageRecord | null, WorkflowRepositoryError>;
  usage(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    nodeRunId: NodeRunId;
  }): Result.ResultAsync<LlmUsage, WorkflowRepositoryError>;
  record(
    record: LlmUsageRecord,
  ): Result.ResultAsync<
    { type: "recorded" } | { type: "existing"; record: LlmUsageRecord },
    WorkflowRepositoryError
  >;
  complete(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    effectId: EffectId;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
    output: JsonValue;
  }): Result.ResultAsync<void, WorkflowRepositoryError>;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** providerへ送る前のdata minimization: secretらしい値を伏せる。 */
export function minimizePrompt(prompt: JsonValue): {
  system?: string;
  prompt: string;
  redactions: number;
} {
  let redactions = 0;
  const redact = (text: string) =>
    SECRET_PATTERNS.reduce(
      (current, pattern) =>
        current.replace(pattern, () => {
          redactions += 1;
          return "[REDACTED]";
        }),
      text,
    );
  if (typeof prompt === "string") return { prompt: redact(prompt), redactions };
  if (
    prompt !== null &&
    typeof prompt === "object" &&
    !Array.isArray(prompt) &&
    typeof prompt["user"] === "string"
  ) {
    const system = typeof prompt["system"] === "string" ? redact(prompt["system"]) : undefined;
    return {
      ...(system !== undefined ? { system } : {}),
      prompt: redact(prompt["user"]),
      redactions,
    };
  }
  return { prompt: redact(JSON.stringify(prompt)), redactions };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cost(
  pricing: LlmPricing,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = pricing[model] ?? {
    inputMicroUsdPer1kTokens: 1000,
    outputMicroUsdPer1kTokens: 1000,
  };
  return Math.ceil(
    (inputTokens * price.inputMicroUsdPer1kTokens +
      outputTokens * price.outputMicroUsdPer1kTokens) /
      1000,
  );
}

/**
 * LLM作用のhandler（LLM Gateway, #161）。
 *
 * - modelはNode grant ∩ 現在の組織policyに含まれる必要がある（capability_denied）
 * - Node（NodeRun）ごとのmax calls / input・output tokens / costをledgerで強制し、超過は
 *   `budget_exhausted`としてdurableに記録する
 * - sandboxやworkflow stateへprovider credentialを渡さない。toolの要求はdataとして返すだけで、
 *   実行は必ず別のAction / Program作用（ActionRequest）で行う（Gatewayはexecutorを持たない）
 */
export class LlmGatewayHandler implements EffectHandler {
  constructor(
    private readonly deps: {
      provider: LlmProvider;
      ledger: LlmUsageLedger;
      broker: CapabilityBroker;
      pricing?: LlmPricing;
      clock: { now(): string };
    },
  ) {}

  private async deny(
    context: EffectContext,
    model: string,
    code: string,
    message: string,
  ): Promise<EffectOutcomeReport> {
    await this.deps.ledger.record({
      organizationId: context.run.state.organizationId,
      runId: context.run.state.runId,
      nodeRunId: context.effect.nodeRunId,
      effectId: context.effect.id,
      model,
      status: "denied",
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      code,
      createdAt: this.deps.clock.now(),
    });
    return { type: "failed", code, message };
  }

  async dispatch(
    context: EffectContext,
  ): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    const request = context.effect.request;
    if (request.kind !== "llm") {
      return Result.succeed({
        type: "failed",
        code: "effect_kind_mismatch",
        message: "llm作用ではありません",
      });
    }
    const organizationId = context.run.state.organizationId;
    const existing = await this.deps.ledger.find({
      organizationId,
      runId: context.run.state.runId,
      effectId: context.effect.id,
    });
    if (Result.isFailure(existing)) {
      return Result.fail(
        new EffectHandlerError(
          existing.error.code,
          existing.error.retriable,
          existing.error.message,
        ),
      );
    }
    if (existing.value?.status === "completed") {
      // 再配送（crash / CAS競合）ではproviderを呼び直さず、記録済みの結果を返す。
      return Result.succeed({ type: "completed", output: existing.value.output ?? null });
    }
    if (existing.value?.status === "denied") {
      return Result.succeed({
        type: "failed",
        code: existing.value.code ?? "budget_exhausted",
        message: "LLM呼び出しは拒否済みです",
      });
    }

    const grantSource =
      context.node.type === "llm" || context.node.type === "program"
        ? context.node.capabilities
        : undefined;
    const limits = await this.deps.broker.authorizeLlm({
      organizationId,
      grant: grantSource,
      model: request.model,
    });
    if (Result.isFailure(limits)) {
      if (limits.error.retriable) return limits;
      return Result.succeed(
        await this.deny(context, request.model, limits.error.code, limits.error.message),
      );
    }
    const minimized = minimizePrompt(request.prompt);
    const inputEstimate = estimateTokens(`${minimized.system ?? ""}${minimized.prompt}`);
    const pricing = this.deps.pricing ?? {};
    const reservedCost = cost(pricing, request.model, inputEstimate, request.maxOutputTokens);

    if (!existing.value) {
      const usage = await this.deps.ledger.usage({
        organizationId,
        runId: context.run.state.runId,
        nodeRunId: context.effect.nodeRunId,
      });
      if (Result.isFailure(usage)) {
        return Result.fail(
          new EffectHandlerError(usage.error.code, usage.error.retriable, usage.error.message),
        );
      }
      const exceeded =
        usage.value.calls + 1 > limits.value.maxCalls
          ? "max calls"
          : usage.value.inputTokens + inputEstimate > limits.value.maxInputTokens
            ? "max input tokens"
            : usage.value.outputTokens + request.maxOutputTokens > limits.value.maxOutputTokens
              ? "max output tokens"
              : usage.value.costMicroUsd + reservedCost > limits.value.maxCostMicroUsd
                ? "max cost"
                : null;
      if (exceeded) {
        return Result.succeed(
          await this.deny(
            context,
            request.model,
            "budget_exhausted",
            `LLM budget（${exceeded}）を超えます`,
          ),
        );
      }
      const reserved = await this.deps.ledger.record({
        organizationId,
        runId: context.run.state.runId,
        nodeRunId: context.effect.nodeRunId,
        effectId: context.effect.id,
        model: request.model,
        status: "reserved",
        inputTokens: inputEstimate,
        outputTokens: request.maxOutputTokens,
        costMicroUsd: reservedCost,
        createdAt: this.deps.clock.now(),
      });
      if (Result.isFailure(reserved)) {
        return Result.fail(
          new EffectHandlerError(
            reserved.error.code,
            reserved.error.retriable,
            reserved.error.message,
          ),
        );
      }
    }

    const completed = await this.deps.provider.complete({
      model: request.model,
      ...(minimized.system !== undefined ? { system: minimized.system } : {}),
      prompt: minimized.prompt,
      maxOutputTokens: request.maxOutputTokens,
    });
    if (Result.isFailure(completed)) {
      if (completed.error.retriable) return completed;
      return Result.succeed({
        type: "failed",
        code: completed.error.code,
        message: completed.error.message,
      });
    }
    const inputTokens = completed.value.inputTokens ?? inputEstimate;
    const outputTokens = Math.min(
      completed.value.outputTokens ?? estimateTokens(completed.value.text),
      request.maxOutputTokens,
    );
    const allowedTools = new Set(
      (grantSource?.actions ?? []).map((action) => String(action.actionType)),
    );
    const output: JsonObject = {
      text: completed.value.text,
      model: request.model,
      usage: { inputTokens, outputTokens },
      ...(completed.value.toolCalls
        ? {
            // toolの要求はdata。実行は必ずAction / Program作用 → ActionRequestで行う。
            toolRequests: completed.value.toolCalls.map((call) => ({
              actionType: call.name,
              input: call.arguments,
              granted: allowedTools.has(call.name),
            })),
          }
        : {}),
      ...(minimized.redactions > 0 ? { redactions: minimized.redactions } : {}),
    };
    const saved = await this.deps.ledger.complete({
      organizationId,
      runId: context.run.state.runId,
      effectId: context.effect.id,
      inputTokens,
      outputTokens,
      costMicroUsd: cost(pricing, request.model, inputTokens, outputTokens),
      output,
    });
    if (Result.isFailure(saved)) {
      return Result.fail(
        new EffectHandlerError(saved.error.code, saved.error.retriable, saved.error.message),
      );
    }
    return Result.succeed({ type: "completed", output });
  }
}

/** 自然言語からProgram sourceを生成するCoding LLM（LLM Provider経由, #160）。 */
export class LlmProgramCodeGenerator implements ProgramCodeGenerator {
  constructor(
    private readonly deps: {
      provider: LlmProvider;
      model: string;
      maxOutputTokens?: number;
    },
  ) {}

  async generate(
    input: Parameters<ProgramCodeGenerator["generate"]>[0],
  ): Result.ResultAsync<{ source: string; model: string }, EffectHandlerError> {
    const model = input.model ?? this.deps.model;
    const minimized = minimizePrompt(input.instruction);
    const completed = await this.deps.provider.complete({
      model,
      system: [
        "You write a single JavaScript function `function main(input, context)` for a sandbox without network, modules, timers or I/O.",
        "Return `ue.complete(output)` with a JSON-serializable output. Use only plain JavaScript (no import/require/fetch).",
        "Only if external actions are required, return `ue.action(state, actionType, {type, id}, input)` and read `context.resume` when resumed.",
        "Reply with the code only, inside one ```javascript code block.",
      ].join("\n"),
      prompt: [
        `Instruction: ${minimized.prompt}`,
        `Input schema: ${JSON.stringify(input.inputSchema)}`,
        `Output schema: ${JSON.stringify(input.outputSchema)}`,
        `Allowed capabilities: ${JSON.stringify(input.requestedCapabilities)}`,
      ].join("\n"),
      maxOutputTokens: this.deps.maxOutputTokens ?? 1024,
    });
    if (Result.isFailure(completed)) return completed;
    const fenced = /```(?:javascript|js)?\s*([\s\S]*?)```/.exec(completed.value.text);
    const source = (fenced?.[1] ?? completed.value.text).trim();
    return Result.succeed({ source, model });
  }
}
