import { Result } from "@praha/byethrow";
import { shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";

import { SandboxError, parseProgramResult } from "@app/workflow-core";
import type { SandboxAdapter, SandboxInvocation, SandboxRunResult } from "@app/workflow-core";

/**
 * Program sourceの前に置くprelude。作用の要求はyieldの値として返すだけで、
 * host機能（network / credential / timer / storage）は一切提供しない。
 */
const PRELUDE = `
const ue = Object.freeze({
  complete: (output) => ({ type: "complete", output }),
  action: (state, actionType, resource, input) =>
    ({ type: "yield", state, effect: { type: "action", actionType, resource, input } }),
  llm: (state, model, prompt, maxOutputTokens) =>
    ({ type: "yield", state, effect: { type: "llm", model, prompt, maxOutputTokens } }),
  sleep: (state, seconds) => ({ type: "yield", state, effect: { type: "timer", seconds } }),
  askHuman: (state, prompt) => ({ type: "yield", state, effect: { type: "human_input", prompt } }),
});
`;

const EPILOGUE = `
;(function () {
  if (typeof main !== "function") throw new TypeError("main(input, context) is not defined");
  const __result = main(JSON.parse(__ue_input), JSON.parse(__ue_context));
  if (__result !== null && typeof __result === "object" && typeof __result.then === "function") {
    throw new TypeError("main must be synchronous");
  }
  const __normalized =
    __result !== null && typeof __result === "object" && (__result.type === "complete" || __result.type === "yield")
      ? __result
      : { type: "complete", output: __result === undefined ? null : __result };
  return JSON.stringify(__normalized);
})()
`;

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function classify(error: unknown): { code: SandboxError["code"]; detail: string } {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const name = typeof record["name"] === "string" ? record["name"] : "Error";
  const message = typeof record["message"] === "string" ? record["message"] : String(error);
  const text = `${name}: ${message}`;
  if (text.includes("interrupted"))
    return { code: "sandbox_timeout", detail: "Programが実行時間の上限を超えました" };
  if (
    text.includes("out of memory") ||
    text.includes("stack overflow") ||
    text.includes("Maximum call stack")
  ) {
    return { code: "sandbox_memory_exceeded", detail: "Programがmemory / stackの上限を超えました" };
  }
  return { code: "program_error", detail: text.slice(0, 500) };
}

class LogCollector {
  readonly lines: string[] = [];
  truncated = false;
  private bytes = 0;

  constructor(private readonly limit: number) {}

  add(line: string): void {
    if (this.truncated) return;
    const size = textBytes(line);
    if (this.bytes + size > this.limit) {
      this.truncated = true;
      return;
    }
    this.bytes += size;
    this.lines.push(line);
  }
}

function describe(context: QuickJSContext, handle: QuickJSHandle): string {
  const value: unknown = context.dump(handle);
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/**
 * QuickJS（WASM）上のsandbox。
 *
 * - invocationごとに新しいruntime / contextを作り、終了時に破棄する（ephemeral。待機中は何も保持しない）
 * - network / fetch / timer / filesystem / process / credentialは存在しない（QuickJSの素のcontext）
 * - hostが提供するのは`console.log`（容量上限付きで記録）だけ
 * - memory / stack / 実行時間（interrupt）/ output / logの上限を強制し、超過はterminateする
 * - 入出力はJSON文字列で受け渡し、結果は`parseProgramResult`で検証する
 */
export class QuickJsSandbox implements SandboxAdapter {
  constructor(private readonly loadModule: () => Promise<QuickJSWASMModule>) {}

  private execute(module: QuickJSWASMModule, invocation: SandboxInvocation, logs: LogCollector) {
    const { limits } = invocation;
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
    const context = runtime.newContext();
    try {
      const log = context.newFunction("log", (...args: QuickJSHandle[]) => {
        logs.add(args.map((arg) => describe(context, arg)).join(" "));
      });
      const consoleObject = context.newObject();
      context.setProp(consoleObject, "log", log);
      context.setProp(consoleObject, "error", log);
      context.setProp(context.global, "console", consoleObject);
      log.dispose();
      consoleObject.dispose();
      for (const [name, value] of [
        ["__ue_input", JSON.stringify(invocation.input)],
        ["__ue_context", JSON.stringify({ resume: invocation.resume ?? null })],
      ] as const) {
        const handle = context.newString(value);
        context.setProp(context.global, name, handle);
        handle.dispose();
      }
      const evaluated = context.evalCode(
        `${PRELUDE}\n${invocation.source}\n${EPILOGUE}`,
        "program.js",
      );
      if (evaluated.error) {
        const error: unknown = context.dump(evaluated.error);
        evaluated.error.dispose();
        return { type: "error" as const, error };
      }
      const value: unknown = context.dump(evaluated.value);
      evaluated.value.dispose();
      return { type: "value" as const, value };
    } finally {
      context.dispose();
      runtime.dispose();
    }
  }

  async run(invocation: SandboxInvocation): Result.ResultAsync<SandboxRunResult, SandboxError> {
    const started = Date.now();
    const loaded = await Result.fn({
      try: () => this.loadModule(),
      catch: (error): SandboxError =>
        new SandboxError({
          code: "sandbox_unavailable",
          detail: error instanceof Error ? error.message : "sandbox moduleを読み込めません",
          retriable: true,
        }),
    })();
    if (Result.isFailure(loaded)) return loaded;
    const logs = new LogCollector(invocation.limits.maxLogBytes);
    const executed = Result.fn({
      try: () => this.execute(loaded.value, invocation, logs),
      catch: (error): SandboxError => {
        const classified = classify(error);
        return new SandboxError({
          code: classified.code,
          detail: classified.detail,
          retriable: false,
        });
      },
    })();
    if (Result.isFailure(executed)) return executed;
    if (executed.value.type === "error") {
      const classified = classify(executed.value.error);
      return Result.fail(
        new SandboxError({ code: classified.code, detail: classified.detail, retriable: false }),
      );
    }
    const raw = executed.value.value;
    if (typeof raw !== "string") {
      return Result.fail(
        new SandboxError({
          code: "program_result_invalid",
          detail: "Programの結果を取得できません",
          retriable: false,
        }),
      );
    }
    if (textBytes(raw) > invocation.limits.maxOutputBytes) {
      return Result.fail(
        new SandboxError({
          code: "sandbox_output_too_large",
          detail: `Programの結果が上限（${invocation.limits.maxOutputBytes} bytes）を超えました`,
          retriable: false,
        }),
      );
    }
    const parsed = Result.fn({
      try: (): unknown => JSON.parse(raw),
      catch: (): SandboxError =>
        new SandboxError({
          code: "program_result_invalid",
          detail: "結果がJSONではありません",
          retriable: false,
        }),
    })();
    if (Result.isFailure(parsed)) return parsed;
    const result = parseProgramResult(parsed.value);
    if (Result.isFailure(result)) {
      return Result.fail(
        new SandboxError({
          code: "program_result_invalid",
          detail: result.error.message,
          retriable: false,
        }),
      );
    }
    return Result.succeed({
      result: result.value,
      logs: logs.lines,
      logsTruncated: logs.truncated,
      durationMs: Date.now() - started,
    });
  }
}
