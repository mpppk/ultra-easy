import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import { isPlainRecord, jsonValueIssue } from "@app/expression-core";
import type { JsonObject, JsonValue } from "@app/expression-core";
import { parseBrand, type UserPrincipalRef } from "@app/approval-core";

import { isJsonSchemaLite, validateJsonSchemaLite, type JsonSchemaLite } from "./schema-lite.ts";

/**
 * Sandbox内のProgramが要求できる外部作用。Programは作用を直接実行せず、yieldして
 * Host Runtime（Capability Broker / ActionRequest / LLM Gateway）に委ねる。
 */
export type ProgramEffect =
  | {
      type: "action";
      actionType: string;
      resource: { type: string; id: string };
      input: JsonObject;
    }
  | { type: "llm"; model: string; prompt: JsonValue; maxOutputTokens: number }
  | { type: "timer"; seconds: number }
  | {
      type: "human_input";
      prompt: string;
      /** Optional for version compatibility; legacy runs assign to the requesting user. */
      assignee?: UserPrincipalRef;
      options?: string[];
      answerSchema?: JsonSchemaLite;
      subject?: { type: string; id: string; title: string };
      analysis?: string;
    };

export type ProgramResult =
  | { type: "complete"; output: JsonValue }
  | { type: "yield"; state: JsonValue; effect: ProgramEffect };

export class ProgramResultInvalidError extends ErrorFactory({
  name: "ProgramResultInvalidError",
  message: ({ detail }) => `Programの結果が不正です: ${detail}`,
  fields: ErrorFactory.fields<{ code: "program_result_invalid"; detail: string }>(),
}) {}

function invalid(detail: string): Result.Result<never, ProgramResultInvalidError> {
  return Result.fail(new ProgramResultInvalidError({ code: "program_result_invalid", detail }));
}

function nonEmptyString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseEffect(value: unknown): Result.Result<ProgramEffect, ProgramResultInvalidError> {
  if (!isPlainRecord(value)) return invalid("effectはobjectである必要があります");
  switch (value["type"]) {
    case "action": {
      const resource = value["resource"];
      const input = value["input"];
      if (
        !nonEmptyString(value["actionType"]) ||
        !isPlainRecord(resource) ||
        !nonEmptyString(resource["type"]) ||
        !nonEmptyString(resource["id"], 1024) ||
        !isPlainRecord(input)
      ) {
        return invalid("action effectにはactionType / resource{type,id} / input objectが必要です");
      }
      return Result.succeed({
        type: "action",
        actionType: value["actionType"],
        resource: { type: resource["type"], id: resource["id"] },
        input: input as JsonObject,
      });
    }
    case "llm": {
      const maxOutputTokens = value["maxOutputTokens"];
      if (
        !nonEmptyString(value["model"]) ||
        typeof maxOutputTokens !== "number" ||
        !Number.isInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        !("prompt" in value)
      ) {
        return invalid("llm effectにはmodel / prompt / maxOutputTokensが必要です");
      }
      return Result.succeed({
        type: "llm",
        model: value["model"],
        prompt: value["prompt"] as JsonValue,
        maxOutputTokens,
      });
    }
    case "timer": {
      const seconds = value["seconds"];
      if (
        typeof seconds !== "number" ||
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > 86_400 * 30
      ) {
        return invalid("timer effectのsecondsは1〜2592000の整数です");
      }
      return Result.succeed({ type: "timer", seconds });
    }
    case "human_input": {
      if (!nonEmptyString(value["prompt"], 4000))
        return invalid("human_input effectにはpromptが必要です");
      const assignee = value["assignee"];
      const options = value["options"];
      const subject = value["subject"];
      const answerSchema = value["answerSchema"];
      let assigneeRef: UserPrincipalRef | undefined;
      if (assignee !== undefined) {
        if (!isPlainRecord(assignee) || assignee["type"] !== "user") {
          return invalid("human_input assigneeはuser principalである必要があります");
        }
        const userId = parseBrand("UserId", assignee["id"]);
        if (Result.isFailure(userId)) {
          return invalid("human_input assigneeはuser principalである必要があります");
        }
        assigneeRef = { type: "user", id: userId.value };
      }
      if (
        options !== undefined &&
        (!Array.isArray(options) ||
          options.length === 0 ||
          options.length > 20 ||
          !options.every((option) => nonEmptyString(option, 256)) ||
          new Set(options).size !== options.length)
      ) {
        return invalid("human_input optionsが不正です");
      }
      if (
        subject !== undefined &&
        (!isPlainRecord(subject) ||
          !nonEmptyString(subject["type"], 128) ||
          !nonEmptyString(subject["id"], 1024) ||
          !nonEmptyString(subject["title"], 512))
      ) {
        return invalid("human_input subjectが不正です");
      }
      if (value["analysis"] !== undefined && !nonEmptyString(value["analysis"], 8000)) {
        return invalid("human_input analysisが不正です");
      }
      if (answerSchema !== undefined && !isJsonSchemaLite(answerSchema)) {
        return invalid("human_input answerSchemaが不正です");
      }
      if (
        answerSchema !== undefined &&
        Array.isArray(options) &&
        options.some((option) => validateJsonSchemaLite(answerSchema, option).length > 0)
      ) {
        return invalid("human_input optionsがanswerSchemaに一致しません");
      }
      return Result.succeed({
        type: "human_input",
        prompt: value["prompt"],
        ...(assigneeRef !== undefined ? { assignee: assigneeRef } : {}),
        ...(options !== undefined ? { options: options as string[] } : {}),
        ...(answerSchema !== undefined ? { answerSchema } : {}),
        ...(subject !== undefined
          ? {
              subject: {
                type: subject["type"] as string,
                id: subject["id"] as string,
                title: subject["title"] as string,
              },
            }
          : {}),
        ...(typeof value["analysis"] === "string" ? { analysis: value["analysis"] } : {}),
      });
    }
    default:
      return invalid("未対応のeffect typeです");
  }
}

/** Sandboxから返った信頼できない値を`ProgramResult`へ検証する（JSON-safeでなければ拒否）。 */
export function parseProgramResult(
  value: unknown,
): Result.Result<ProgramResult, ProgramResultInvalidError> {
  if (jsonValueIssue(value)) return invalid("JSONとして表現できない値です");
  if (!isPlainRecord(value)) return invalid("結果はobjectである必要があります");
  if (value["type"] === "complete") {
    if (!("output" in value)) return invalid("completeにはoutputが必要です");
    return Result.succeed({ type: "complete", output: value["output"] as JsonValue });
  }
  if (value["type"] === "yield") {
    const effect = parseEffect(value["effect"]);
    if (Result.isFailure(effect)) return effect;
    return Result.succeed({
      type: "yield",
      state: (value["state"] ?? null) as JsonValue,
      effect: effect.value,
    });
  }
  return invalid("typeはcompleteまたはyieldである必要があります");
}

/**
 * Programが **要求** するcapability（自己grantはできない）。実効grantはCapability Broker（#161）が
 * user / admin policyとの積で決め、Program NodeのCapabilityGrantとして固定する。
 */
export type ProgramCapabilityManifest = {
  actions?: { actionType: string; resourceType?: string }[];
  llm?: {
    models: string[];
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicroUsd: number;
  };
  maxEffects?: number;
};

/** sandboxのresource上限（runtime profile）。 */
export type SandboxLimits = {
  memoryBytes: number;
  timeoutMs: number;
  maxOutputBytes: number;
  maxLogBytes: number;
  stackBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  timeoutMs: 1000,
  maxOutputBytes: 256 * 1024,
  maxLogBytes: 8 * 1024,
  stackBytes: 512 * 1024,
};

export const MAX_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 128 * 1024 * 1024,
  timeoutMs: 10_000,
  maxOutputBytes: 1024 * 1024,
  maxLogBytes: 64 * 1024,
  stackBytes: 2 * 1024 * 1024,
};

export type ProgramGeneratorMetadata = {
  kind: "llm" | "manual";
  model?: string;
  /** 自然言語指示のsha256（promptそのものは保存しない）。 */
  instructionDigest?: string;
  generatedAt: string;
};

/**
 * publish済みのimmutableなProgram Node Version。runtimeで毎回コードを再生成せず、
 * このsource / digestだけを実行する。
 */
export type ProgramNodeVersion = {
  programId: string;
  version: number;
  language: "javascript";
  source: string;
  /** sourceのsha256（`sha256:<hex>`）。Program Nodeの参照と実行時に照合する。 */
  sourceDigest: string;
  inputSchema: JsonSchemaLite;
  outputSchema: JsonSchemaLite;
  requestedCapabilities: ProgramCapabilityManifest;
  runtimeProfile: SandboxLimits;
  generator: ProgramGeneratorMetadata;
  description?: string;
  publishedAt: string;
  publishedBy: string;
};

export type SandboxInvocation = {
  source: string;
  input: JsonValue;
  /** yieldした作用の結果から再開する場合の、明示的にserializeされたstate。 */
  resume?: { state: JsonValue; effectResult: JsonValue };
  limits: SandboxLimits;
};

export type SandboxRunResult = {
  result: ProgramResult;
  logs: string[];
  logsTruncated: boolean;
  durationMs: number;
};

export type SandboxErrorCode =
  | "sandbox_timeout"
  | "sandbox_memory_exceeded"
  | "sandbox_output_too_large"
  | "program_error"
  | "program_result_invalid"
  | "sandbox_unavailable";

export class SandboxError extends ErrorFactory({
  name: "SandboxError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{ code: SandboxErrorCode; detail: string; retriable: boolean }>(),
}) {}

/**
 * untrusted codeを隔離実行するport。実装は network / credential / host binding（log以外）を
 * 一切与えず、invocationごとにephemeralな環境を作って破棄する（待機中にprocessを保持しない）。
 */
export interface SandboxAdapter {
  run(invocation: SandboxInvocation): Result.ResultAsync<SandboxRunResult, SandboxError>;
}
