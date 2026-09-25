import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { JsonValue } from "@app/expression-core";

import type { WorkflowDefinition, WorkflowVersion } from "./definition.ts";
import type { EffectId } from "./ids.ts";
import {
  advanceWorkflowRun,
  applyWorkflowRunEvent,
  cancellationsToPropagate,
  dispatchableEffects,
  startWorkflowRun,
} from "./scheduler.ts";
import type { WorkflowRunEvent } from "./scheduler.ts";
import type { EffectRecord, WorkflowRunState } from "./state.ts";
import {
  TEST_CONTEXT,
  TEST_ORGANIZATION_ID,
  definition,
  edges,
  eq,
  f,
  graph,
  gt,
  id,
  lit,
  lt,
  n,
  obj,
  runId,
} from "./testing/index.ts";
import { publishWorkflowVersion } from "./version.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-12-01T00:00:00.000Z";

async function publish(def: WorkflowDefinition): Promise<WorkflowVersion> {
  const published = await publishWorkflowVersion({
    definition: def,
    latestVersion: null,
    publishedAt: T0,
    publishedBy: TEST_CONTEXT.actor,
  });
  if (Result.isFailure(published)) {
    expect.fail(JSON.stringify(published.error.issues ?? published.error.message));
  }
  return published.value;
}

function start(version: WorkflowVersion, input: Record<string, JsonValue> = {}, now = T0) {
  return startWorkflowRun({
    runId: runId(),
    organizationId: TEST_ORGANIZATION_ID,
    version,
    input,
    context: TEST_CONTEXT,
    now,
  });
}

function apply(
  state: WorkflowRunState,
  version: WorkflowVersion,
  event: WorkflowRunEvent,
  now = T0,
): WorkflowRunState {
  const result = applyWorkflowRunEvent(state, version.definition, event, now);
  if (Result.isFailure(result)) expect.fail(result.error.message);
  return result.value.state;
}

function effectFor(state: WorkflowRunState, nodeRunId: string): EffectRecord {
  const effect = Object.values(state.effects).find(
    (candidate) =>
      String(candidate.nodeRunId) === nodeRunId &&
      (candidate.status === "requested" || candidate.status === "in_flight"),
  );
  if (!effect) expect.fail(`effect for ${nodeRunId} not found`);
  return effect;
}

function complete(
  state: WorkflowRunState,
  version: WorkflowVersion,
  nodeRunId: string,
  output: JsonValue,
): WorkflowRunState {
  return apply(state, version, {
    type: "effect_completed",
    effectId: effectFor(state, nodeRunId).id,
    output,
  });
}

function statusOf(state: WorkflowRunState, nodeRunId: string): string | undefined {
  return state.nodeRuns[nodeRunId]?.status;
}

describe("workflow-core scheduler semantics (#156)", () => {
  it("linear Action workflow completes after the child effect result", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("create", "google.create_account", obj({ email: f("workflow.input.email") })),
            n.output(obj({ account: f("nodes.create.output.accountId") })),
          ],
          edges("start->create", "create->end"),
        ),
      ),
    );
    let state = start(version, { email: "bob@example.com" });
    expect(state.status).toBe("waiting");
    const effect = effectFor(state, "root:create");
    expect(effect.request).toMatchObject({
      kind: "action",
      actionType: "google.create_account",
      input: { email: "bob@example.com" },
    });
    state = complete(state, version, "root:create", { accountId: "acct-1" });
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual({ account: "acct-1" });
  });

  it("Branch -> A|B -> Join completes without waiting for the not-taken path", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.branch(
              "route",
              [
                {
                  key: "large",
                  when: gt(f("workflow.input.amount"), f("organization.settings.approvalLimit")),
                },
              ],
              "small",
            ),
            n.action("large_path", "payment.large"),
            n.action("small_path", "payment.small"),
            n.join("merge"),
            n.output(f("nodes.merge.output")),
          ],
          edges(
            "start->route",
            ["route", "large_path", "large"],
            ["route", "small_path", "small"],
            "large_path->merge",
            "small_path->merge",
            "merge->end",
          ),
        ),
      ),
    );
    let state = start(version, { amount: 50_000 });
    expect(state.decisions).toEqual([expect.objectContaining({ kind: "branch", value: "large" })]);
    expect(statusOf(state, "root:small_path")).toBe("skipped");
    expect(Object.values(state.effects).map((effect) => String(effect.nodeRunId))).toEqual([
      "root:large_path",
    ]);
    expect(state.edges["root|e2"]).toBe("not_taken");
    state = complete(state, version, "root:large_path", { paid: true });
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual({ large_path: { paid: true } });
  });

  it("parallel fan-out -> Join waits for every active path", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("a", "github.add_member"),
            n.action("b", "equipment.order"),
            n.join("both"),
            n.output(f("nodes.both.output")),
          ],
          edges("start->a", "start->b", "a->both", "b->both", "both->end"),
        ),
      ),
    );
    let state = start(version);
    expect(dispatchableEffects(state, T0)).toHaveLength(2);
    state = complete(state, version, "root:a", "A");
    expect(state.status).toBe("waiting");
    expect(statusOf(state, "root:both")).toBe("pending");
    state = complete(state, version, "root:b", "B");
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual({ a: "A", b: "B" });
  });

  it("empty ForEach succeeds with [] without body NodeRuns and activates downstream once", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.forEach(
              "each",
              f("workflow.input.items"),
              graph([n.action("work", "task.run", obj({ item: f("loop.item") }))], []),
            ),
            n.transform("after", f("nodes.each.output")),
            n.output(f("nodes.after.output")),
          ],
          edges("start->each", "each->after", "after->end"),
        ),
      ),
    );
    const state = start(version, { items: [] });
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual([]);
    expect(Object.keys(state.nodeRuns).filter((key) => key.includes("work"))).toEqual([]);
    expect(Object.keys(state.nodeRuns).filter((key) => key.endsWith(":after"))).toEqual([
      "root:after",
    ]);
    expect(Object.keys(state.effects)).toEqual([]);
  });

  it("iteration-scoped Join never mixes NodeRuns of different iterations", async () => {
    const body = graph(
      [
        n.transform("prep", f("loop.item")),
        n.action("left", "task.left", obj({ item: f("nodes.prep.output") })),
        n.action("right", "task.right", obj({ index: f("loop.index") })),
        n.join("pair"),
        n.output(obj({ item: f("loop.item"), pair: f("nodes.pair.output") }), "iter_end"),
      ],
      edges("prep->left", "prep->right", "left->pair", "right->pair", "pair->iter_end"),
    );
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.forEach("each", f("workflow.input.items"), body),
            n.output(f("nodes.each.output")),
          ],
          edges("start->each", "each->end"),
        ),
      ),
    );
    let state = start(version, { items: ["x", "y"] });
    const s0 = "root/each[0]";
    const s1 = "root/each[1]";
    expect(effectFor(state, `${s1}:right`).request).toMatchObject({ input: { index: 1 } });
    state = complete(state, version, `${s0}:left`, "L0");
    state = complete(state, version, `${s1}:right`, "R1");
    expect(statusOf(state, `${s0}:pair`)).toBe("pending");
    expect(statusOf(state, `${s1}:pair`)).toBe("pending");
    state = complete(state, version, `${s0}:right`, "R0");
    expect(statusOf(state, `${s0}:pair`)).toBe("succeeded");
    expect(state.nodeRuns[`${s0}:pair`]?.output).toEqual({ left: "L0", right: "R0" });
    expect(statusOf(state, `${s1}:pair`)).toBe("pending");
    state = complete(state, version, `${s1}:left`, "L1");
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual([
      { item: "x", pair: { left: "L0", right: "R0" } },
      { item: "y", pair: { left: "L1", right: "R1" } },
    ]);
  });

  it("ForEach concurrency bounds the number of running iterations", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.forEach(
              "each",
              f("workflow.input.items"),
              graph([n.action("work", "task.run", obj({ item: f("loop.item") }))], []),
              { concurrency: 1 },
            ),
            n.output(f("nodes.each.output")),
          ],
          edges("start->each", "each->end"),
        ),
      ),
    );
    let state = start(version, { items: [1, 2, 3] });
    expect(Object.keys(state.scopes)).toEqual(["root", "root/each[0]"]);
    state = complete(state, version, "root/each[0]:work", "one");
    expect(Object.keys(state.scopes)).toEqual(["root", "root/each[0]", "root/each[1]"]);
    state = complete(state, version, "root/each[1]:work", "two");
    state = complete(state, version, "root/each[2]:work", "three");
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual([null, null, null]);
    expect(state.nodeRuns["root:each"]?.output).toEqual([null, null, null]);
  });

  it("ForEach rejects collections over maxItems (bounded)", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.forEach("each", f("workflow.input.items"), graph([n.transform("noop", lit(1))], []), {
              maxItems: 2,
            }),
            n.output(lit(null)),
          ],
          edges("start->each", "each->end"),
        ),
      ),
    );
    const state = start(version, { items: [1, 2, 3] });
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("for_each_too_many_items");
  });

  it("While iterates while the condition holds and is bounded by maxIterations", async () => {
    const loopBody = graph([n.transform("tick", f("loop.index"), { last: f("loop.index") })], []);
    const bounded = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.while("loop", lt(f("loop.index"), lit(3)), loopBody, 5),
            n.output(f("nodes.loop.output")),
          ],
          edges("start->loop", "loop->end"),
        ),
      ),
    );
    const state = start(bounded);
    expect(state.status).toBe("succeeded");
    expect(state.output).toEqual({ iterations: 3, last: null });
    expect(state.variables).toEqual({ last: 2 });
    expect(state.decisions.map((decision) => [decision.kind, decision.iteration])).toEqual([
      ["while_continue", 0],
      ["while_continue", 1],
      ["while_continue", 2],
      ["while_exit", 3],
    ]);

    const runaway = await publish(
      definition(
        graph(
          [n.trigger(), n.while("loop", eq(lit(1), lit(1)), loopBody, 4), n.output(lit(null))],
          edges("start->loop", "loop->end"),
        ),
      ),
    );
    const failed = start(runaway);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("while_max_iterations_exceeded");
  });

  it("branch decisions persist across a JSON round trip and are not re-evaluated on resume", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.branch(
              "route",
              [{ key: "early", when: lt(f("now"), lit("2026-06-01T00:00:00.000Z")) }],
              "late",
            ),
            n.action("early_path", "task.early"),
            n.action("late_path", "task.late"),
            n.join("merge"),
            n.output(f("nodes.merge.output")),
          ],
          edges(
            "start->route",
            ["route", "early_path", "early"],
            ["route", "late_path", "late"],
            "early_path->merge",
            "late_path->merge",
            "merge->end",
          ),
        ),
      ),
    );
    const started = start(version, {}, T0);
    // process memoryを捨てて永続化済みJSONから再開する。
    const persisted = JSON.parse(JSON.stringify(started)) as WorkflowRunState;
    const resumed = advanceWorkflowRun(persisted, version.definition, T1);
    expect(resumed.decisions).toHaveLength(1);
    expect(statusOf(resumed, "root:late_path")).toBe("skipped");
    expect(Object.values(resumed.effects).map((effect) => String(effect.nodeRunId))).toEqual([
      "root:early_path",
    ]);
    const done = applyWorkflowRunEvent(
      resumed,
      version.definition,
      { type: "effect_completed", effectId: effectFor(resumed, "root:early_path").id, output: 1 },
      T1,
    );
    expect(Result.isSuccess(done) && done.value.state.output).toEqual({ early_path: 1 });
  });

  it("unhandled child failure fails the run fast and cancels in-flight siblings", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("a", "task.a"),
            n.action("b", "task.b"),
            n.join("both"),
            n.output(f("nodes.both.output")),
          ],
          edges("start->a", "start->b", "a->both", "b->both", "both->end"),
        ),
      ),
    );
    let state = start(version);
    state = apply(state, version, {
      type: "effect_dispatched",
      effectId: effectFor(state, "root:b").id,
      reference: "action:child-b",
    });
    state = apply(state, version, {
      type: "effect_failed",
      effectId: effectFor(state, "root:a").id,
      code: "rejected",
      message: "child ActionRequest was rejected",
    });
    expect(state.status).toBe("failed");
    expect(state.error).toMatchObject({ code: "rejected", nodeRunId: "root:a" });
    expect(statusOf(state, "root:b")).toBe("cancelled");
    expect(cancellationsToPropagate(state).map((effect) => effect.reference)).toEqual([
      "action:child-b",
    ]);
  });

  it("a failing iteration fails the enclosing ForEach and the run (v1 fail-fast)", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.forEach(
              "each",
              f("workflow.input.items"),
              graph([n.action("work", "task.run", obj({ item: f("loop.item") }))], []),
            ),
            n.output(f("nodes.each.output")),
          ],
          edges("start->each", "each->end"),
        ),
      ),
    );
    let state = start(version, { items: [1, 2] });
    state = apply(state, version, {
      type: "effect_failed",
      effectId: effectFor(state, "root/each[1]:work").id,
      code: "execution_failed",
      message: "boom",
    });
    expect(state.status).toBe("failed");
    expect(statusOf(state, "root:each")).toBe("failed");
    expect(state.scopes["root/each[0]"]?.status).toBe("cancelled");
    expect(statusOf(state, "root/each[0]:work")).toBe("cancelled");
  });

  it("duplicate / stale / unknown events are idempotent or rejected", async () => {
    const version = await publish(
      definition(
        graph(
          [n.trigger(), n.action("a", "task.a"), n.output(f("nodes.a.output"))],
          edges("start->a", "a->end"),
        ),
      ),
    );
    const state = start(version);
    const effectId = effectFor(state, "root:a").id;
    const first = applyWorkflowRunEvent(
      state,
      version.definition,
      { type: "effect_completed", effectId, output: 1 },
      T0,
    );
    if (Result.isFailure(first)) expect.fail(first.error.message);
    const replay = applyWorkflowRunEvent(
      first.value.state,
      version.definition,
      { type: "effect_completed", effectId, output: 2 },
      T0,
    );
    expect(Result.isSuccess(replay) && replay.value.outcome).toBe("duplicate");
    expect(Result.isSuccess(replay) && replay.value.state.output).toBe(1);
    const unknown = applyWorkflowRunEvent(
      state,
      version.definition,
      { type: "effect_completed", effectId: id<EffectId>("root:other#1"), output: 1 },
      T0,
    );
    expect(Result.isFailure(unknown) && unknown.error.code).toBe("unknown_effect");
  });

  it("cancellation converges to a terminal state and marks effects for propagation", async () => {
    const version = await publish(
      definition(
        graph(
          [n.trigger(), n.action("a", "task.a"), n.output(lit(null))],
          edges("start->a", "a->end"),
        ),
      ),
    );
    let state = start(version);
    state = apply(state, version, {
      type: "effect_dispatched",
      effectId: effectFor(state, "root:a").id,
      reference: "action:child-a",
    });
    state = apply(state, version, { type: "cancel", reason: "parent cancelled" });
    expect(state.status).toBe("cancelled");
    expect(statusOf(state, "root:a")).toBe("cancelled");
    const [pending] = cancellationsToPropagate(state);
    expect(pending?.reference).toBe("action:child-a");
    state = apply(state, version, {
      type: "effect_cancel_propagated",
      effectId: pending?.id ?? id<EffectId>("x"),
    });
    expect(cancellationsToPropagate(state)).toEqual([]);
    const late = applyWorkflowRunEvent(
      state,
      version.definition,
      { type: "effect_completed", effectId: pending?.id ?? id<EffectId>("x"), output: 1 },
      T0,
    );
    expect(Result.isSuccess(late) && late.value.outcome).toBe("stale");
  });

  it("retry policy re-requests a retriable failure with a new deterministic effect id after backoff", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("a", "task.a", obj({}), lit("r"), {
              retry: { maxAttempts: 2, backoffSeconds: 30 },
            }),
            n.output(f("nodes.a.output")),
          ],
          edges("start->a", "a->end"),
        ),
      ),
    );
    let state = start(version);
    const firstId = effectFor(state, "root:a").id;
    state = apply(state, version, {
      type: "effect_failed",
      effectId: firstId,
      code: "temporarily_unavailable",
      message: "try later",
      retriable: true,
    });
    expect(state.status).toBe("waiting");
    const retry = effectFor(state, "root:a");
    expect(String(retry.id)).toBe("root:a#2");
    expect(dispatchableEffects(state, T0)).toEqual([]);
    expect(
      dispatchableEffects(state, "2026-01-01T00:00:30.000Z").map((effect) => effect.id),
    ).toEqual([retry.id]);
  });

  it("maxParallelEffects throttles effectful nodes and NodeRun limit guards runaway graphs", async () => {
    const throttled = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("a", "task.a"),
            n.action("b", "task.b"),
            n.join("j"),
            n.output(lit(1)),
          ],
          edges("start->a", "start->b", "a->j", "b->j", "j->end"),
        ),
        { limits: { maxParallelEffects: 1 } },
      ),
    );
    let state = start(throttled);
    expect(Object.keys(state.effects)).toEqual(["root:a#1"]);
    expect(statusOf(state, "root:b")).toBe("ready");
    state = complete(state, throttled, "root:a", 1);
    expect(Object.keys(state.effects)).toEqual(["root:a#1", "root:b#1"]);

    const limited = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.forEach("each", f("workflow.input.items"), graph([n.transform("t", lit(1))], []), {
              concurrency: 4,
            }),
            n.output(lit(null)),
          ],
          edges("start->each", "each->end"),
        ),
        { limits: { maxNodeRuns: 5 } },
      ),
    );
    const failed = start(limited, { items: [1, 2, 3, 4, 5] });
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("node_run_limit_exceeded");
  });

  it("Program Node yields effects, resumes from persisted state, and fails closed on capability denial", async () => {
    const programNode = {
      id: id<"prog">("prog"),
      type: "program" as const,
      program: { programId: id("program:x"), version: 1, sourceDigest: id("sha256:abc") },
      input: obj({ n: f("workflow.input.n") }),
    };
    const version = await publish(
      definition(
        graph(
          [n.trigger(), programNode as never, n.output(f("nodes.prog.output"))],
          edges("start->prog", "prog->end"),
        ),
      ),
    );
    let state = start(version, { n: 2 });
    const programEffect = effectFor(state, "root:prog");
    expect(programEffect.request).toMatchObject({ kind: "program", input: { n: 2 } });
    state = apply(state, version, {
      type: "program_yielded",
      effectId: programEffect.id,
      state: { step: 1 },
      effect: { type: "action", actionType: "task.a", resource: { type: "t", id: "1" }, input: {} },
    });
    const sub = effectFor(state, "root:prog");
    expect(sub.parentEffectId).toBe(programEffect.id);
    expect(sub.request).toMatchObject({ kind: "action", actionType: "task.a" });
    state = complete(state, version, "root:prog", { ok: true });
    const resume = effectFor(state, "root:prog");
    expect(resume.request).toMatchObject({
      kind: "program",
      resume: { state: { step: 1 }, effectResult: { type: "completed", output: { ok: true } } },
    });
    state = complete(state, version, "root:prog", { answer: 42 });
    expect(state.output).toEqual({ answer: 42 });

    let denied = start(version, { n: 1 });
    denied = apply(denied, version, {
      type: "program_yielded",
      effectId: effectFor(denied, "root:prog").id,
      state: null,
      effect: {
        type: "action",
        actionType: "payment.execute",
        resource: { type: "t", id: "1" },
        input: {},
      },
    });
    denied = apply(denied, version, {
      type: "effect_failed",
      effectId: effectFor(denied, "root:prog").id,
      code: "capability_denied",
      message: "payment.execute is not granted",
    });
    expect(denied.status).toBe("failed");
    expect(denied.error?.code).toBe("capability_denied");
  });
});
