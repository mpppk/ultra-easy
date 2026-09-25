import { Result } from "@praha/byethrow";
import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_SANDBOX_LIMITS } from "@app/workflow-core";
import type { SandboxLimits } from "@app/workflow-core";

import { nodeQuickJsModule } from "./node.ts";
import { QuickJsSandbox } from "./quickjs-sandbox.ts";
import { validateProgramSource } from "./validator.ts";

const sandbox = new QuickJsSandbox(nodeQuickJsModule);

async function run(
  source: string,
  input: unknown = {},
  limits: Partial<SandboxLimits> = {},
  resume?: unknown,
) {
  return sandbox.run({
    source,
    input: input as never,
    ...(resume !== undefined ? { resume: resume as never } : {}),
    limits: { ...DEFAULT_SANDBOX_LIMITS, ...limits },
  });
}

function errorCode(result: Awaited<ReturnType<typeof run>>): string | undefined {
  return Result.isFailure(result) ? result.error.code : undefined;
}

describe("QuickJS sandbox (#160)", () => {
  it("runs a pure transform and returns complete(output)", async () => {
    const result = await run(
      `function main(input) {
         const total = input.items.reduce((sum, item) => sum + item.price * item.qty, 0);
         console.log("items", input.items.length);
         return ue.complete({ total, vip: total > 1000 });
       }`,
      {
        items: [
          { price: 300, qty: 2 },
          { price: 500, qty: 1 },
        ],
      },
    );
    expect(Result.isSuccess(result) && result.value).toMatchObject({
      result: { type: "complete", output: { total: 1100, vip: true } },
      logs: ["items 2"],
    });
  });

  it("requests external capabilities only by yielding effects and resumes from explicit state", async () => {
    const source = `function main(input, context) {
      if (context.resume === null) {
        return ue.action({ step: 1 }, "payment.execute", { type: "invoice", id: input.id }, { amount: input.amount });
      }
      return ue.complete({ state: context.resume.state, paid: context.resume.effectResult.output });
    }`;
    const first = await run(source, { id: "INV-1", amount: 100 });
    expect(Result.isSuccess(first) && first.value.result).toEqual({
      type: "yield",
      state: { step: 1 },
      effect: {
        type: "action",
        actionType: "payment.execute",
        resource: { type: "invoice", id: "INV-1" },
        input: { amount: 100 },
      },
    });
    // 待機後は新しいsandboxで、永続化したstate + 作用の結果から再開する。
    const resumed = await run(
      source,
      { id: "INV-1", amount: 100 },
      {},
      {
        state: { step: 1 },
        effectResult: { type: "completed", output: { receipt: "R-1" } },
      },
    );
    expect(Result.isSuccess(resumed) && resumed.value.result).toEqual({
      type: "complete",
      output: { state: { step: 1 }, paid: { receipt: "R-1" } },
    });
  });

  it("has no network, module, process, or timer access", async () => {
    const probe = await run(`function main() {
      return ue.complete({
        fetch: typeof fetch,
        xhr: typeof XMLHttpRequest,
        require: typeof require,
        process: typeof process,
        setTimeout: typeof setTimeout,
        crypto: typeof crypto,
        navigator: typeof navigator,
      });
    }`);
    expect(Result.isSuccess(probe) && probe.value.result).toEqual({
      type: "complete",
      output: {
        fetch: "undefined",
        xhr: "undefined",
        require: "undefined",
        process: "undefined",
        setTimeout: "undefined",
        crypto: "undefined",
        navigator: "undefined",
      },
    });
    const dynamicImport = await run(`function main() { return import("node:fs"); }`);
    expect(errorCode(dynamicImport)).toBe("program_error");
  });

  it("terminates runaway CPU, memory, stack, and output (tenant-safe limits)", async () => {
    expect(
      errorCode(await run(`function main() { while (true) {} }`, {}, { timeoutMs: 100 })),
    ).toBe("sandbox_timeout");
    expect(
      errorCode(
        await run(
          `function main() { const a = []; while (true) a.push("x".repeat(1024 * 1024)); }`,
          {},
          {
            memoryBytes: 8 * 1024 * 1024,
          },
        ),
      ),
    ).toBe("sandbox_memory_exceeded");
    expect(
      errorCode(await run(`function main() { return main(); }`, {}, { stackBytes: 64 * 1024 })),
    ).toBe("sandbox_memory_exceeded");
    expect(
      errorCode(
        await run(
          `function main() { return ue.complete("x".repeat(10000)); }`,
          {},
          { maxOutputBytes: 1000 },
        ),
      ),
    ).toBe("sandbox_output_too_large");
  }, 30_000);

  it("truncates logs and rejects invalid results", async () => {
    const noisy = await run(
      `function main() { for (let i = 0; i < 1000; i++) console.log("line " + i); return 1; }`,
      {},
      {
        maxLogBytes: 64,
      },
    );
    expect(Result.isSuccess(noisy) && noisy.value.logsTruncated).toBe(true);
    expect(Result.isSuccess(noisy) && noisy.value.logs.join("").length).toBeLessThanOrEqual(64);
    expect(
      errorCode(
        await run(`function main() { return { type: "yield", effect: { type: "rm -rf" } }; }`),
      ),
    ).toBe("program_result_invalid");
    expect(errorCode(await run(`function main() { return Promise.resolve(1); }`))).toBe(
      "program_error",
    );
    expect(errorCode(await run(`function notMain() {}`))).toBe("program_error");
  });

  it("isolates invocations: global mutations do not leak between runs or into the host", async () => {
    await run(
      `globalThis.leaked = 42; Object.prototype.polluted = true; function main() { return 1; }`,
    );
    const next = await run(
      `function main() { return ue.complete({ leaked: typeof leaked, polluted: ({}).polluted === true }); }`,
    );
    expect(Result.isSuccess(next) && next.value.result).toEqual({
      type: "complete",
      output: { leaked: "undefined", polluted: false },
    });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("static validation rejects network / module / host access before any sandbox run", () => {
    expect(
      validateProgramSource(`function main() { return fetch("https://evil.example"); }`).map(
        (issue) => issue.code,
      ),
    ).toEqual(["network_access"]);
    expect(
      validateProgramSource(`const fs = require("fs"); function main() {}`).map(
        (issue) => issue.code,
      ),
    ).toEqual(["module_require"]);
    expect(validateProgramSource(`function run() {}`).map((issue) => issue.code)).toEqual([
      "main_missing",
    ]);
    expect(validateProgramSource(`function main(input) { return input; }`)).toEqual([]);
  });

  it("terminates runaway code even when the clock does not advance (Cloudflare Workers)", async () => {
    const frozen = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(frozen);
    const result = await run(
      `function main() { let i = 0; while (true) { i++; } }`,
      {},
      { timeoutMs: 50 },
    );
    spy.mockRestore();
    expect(errorCode(result)).toBe("sandbox_timeout");
  });
});
