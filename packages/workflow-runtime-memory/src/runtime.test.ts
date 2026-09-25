import { Result } from "@praha/byethrow";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { JsonValue } from "@app/expression-core";
import {
  EffectHandlerError,
  HumanInputEffectHandler,
  TimerEffectHandler,
  WorkflowRuntime,
} from "@app/workflow-application";
import type {
  EffectContext,
  EffectHandler,
  EffectOutcomeReport,
  WorkflowCompletionListener,
  WorkflowInvocation,
  WorkflowRunRecord,
} from "@app/workflow-application";
import { publishWorkflowVersion } from "@app/workflow-core";
import type { WorkflowDefinition, WorkflowRunId, WorkflowVersion } from "@app/workflow-core";
import {
  TEST_ACTOR,
  TEST_CONTEXT,
  TEST_ORGANIZATION_ID,
  definition,
  edges,
  f,
  graph,
  gt,
  id,
  lit,
  n,
  obj,
} from "@app/workflow-core/testing";

import {
  InMemoryWorkflowRunRepository,
  InMemoryWorkflowVersionRepository,
} from "./repositories.ts";

class ManualClock {
  constructor(public value = "2026-09-25T00:00:00.000Z") {}
  now(): string {
    return this.value;
  }
  advance(seconds: number): void {
    this.value = new Date(Date.parse(this.value) + seconds * 1000).toISOString();
  }
}

/**
 * child ActionRequestを模した冪等なaction handler。effect IDで一度だけ「作成」し、
 * 結果はtestが`resolve`で確定する。
 */
class FakeActionHandler implements EffectHandler {
  readonly created = new Map<string, number>();
  readonly results = new Map<string, EffectOutcomeReport>();
  readonly cancelled: string[] = [];
  immediate = false;

  async dispatch(context: EffectContext) {
    const effectId = String(context.effect.id);
    this.created.set(effectId, (this.created.get(effectId) ?? 0) + 1);
    if (this.immediate) {
      return Result.succeed<EffectOutcomeReport>({
        type: "completed",
        output: { done: effectId },
        reference: `child:${effectId}`,
      });
    }
    return Result.succeed<EffectOutcomeReport>({
      type: "in_flight",
      waitingReason: "waiting_approval",
      reference: `child:${effectId}`,
    });
  }

  async poll(context: EffectContext) {
    return Result.succeed<EffectOutcomeReport>(
      this.results.get(String(context.effect.id)) ?? {
        type: "in_flight",
        waitingReason: "waiting_approval",
      },
    );
  }

  async cancel(context: EffectContext) {
    this.cancelled.push(String(context.effect.id));
    return Result.succeed(undefined);
  }

  resolve(effectId: string, output: JsonValue): void {
    this.results.set(effectId, { type: "completed", output });
  }

  reject(effectId: string, code: string): void {
    this.results.set(effectId, { type: "failed", code, message: code });
  }
}

class RecordingCompletion implements WorkflowCompletionListener {
  readonly delivered: WorkflowRunRecord[] = [];
  failuresRemaining = 0;

  async completed(record: WorkflowRunRecord) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Result.fail(new EffectHandlerError("parent_unavailable", true, "parent unavailable"));
    }
    this.delivered.push(record);
    return Result.succeed(undefined);
  }
}

const invocation: WorkflowInvocation = {
  actor: TEST_ACTOR,
  authority: { principal: TEST_ACTOR },
  origin: { type: "system" },
};

let clock: ManualClock;
let versions: InMemoryWorkflowVersionRepository;
let runs: InMemoryWorkflowRunRepository;
let actions: FakeActionHandler;
let completion: RecordingCompletion;

function runtime(): WorkflowRuntime {
  // 毎回新しいinstance = process memoryを持たない（crash後の再起動を模す）。
  return new WorkflowRuntime({
    versions,
    runs,
    clock,
    completion,
    effects: {
      action: actions,
      timer: new TimerEffectHandler(),
      human_input: new HumanInputEffectHandler(),
    },
    pollIntervalSeconds: 10,
  });
}

async function publish(def: WorkflowDefinition): Promise<WorkflowVersion> {
  const published = await publishWorkflowVersion({
    definition: def,
    latestVersion: null,
    publishedAt: clock.now(),
    publishedBy: TEST_ACTOR,
  });
  if (Result.isFailure(published)) expect.fail(published.error.message);
  await versions.save({ organizationId: TEST_ORGANIZATION_ID, version: published.value });
  return published.value;
}

async function start(
  version: WorkflowVersion,
  input: Record<string, JsonValue> = {},
  runId = "run:1",
) {
  const started = await runtime().start({
    organizationId: TEST_ORGANIZATION_ID,
    runId: id<WorkflowRunId>(runId),
    definitionId: version.definitionId,
    version: version.version,
    checksum: String(version.checksum),
    input,
    context: TEST_CONTEXT,
    invocation,
    depth: 0,
  });
  if (Result.isFailure(started)) expect.fail(started.error.message);
  return started.value;
}

async function advance(runId = "run:1") {
  const advanced = await runtime().advance({
    organizationId: TEST_ORGANIZATION_ID,
    runId: id<WorkflowRunId>(runId),
  });
  if (Result.isFailure(advanced)) expect.fail(advanced.error.message);
  return advanced.value;
}

async function load(runId = "run:1"): Promise<WorkflowRunRecord> {
  const loaded = await runs.load({
    organizationId: TEST_ORGANIZATION_ID,
    runId: id<WorkflowRunId>(runId),
  });
  if (Result.isFailure(loaded) || !loaded.value) expect.fail("run not found");
  return loaded.value;
}

beforeEach(() => {
  clock = new ManualClock();
  versions = new InMemoryWorkflowVersionRepository();
  runs = new InMemoryWorkflowRunRepository();
  actions = new FakeActionHandler();
  completion = new RecordingCompletion();
});

const parallel = definition(
  graph(
    [
      n.trigger(),
      n.action("a", "github.add_member", obj({ user: f("workflow.input.user") })),
      n.action("b", "equipment.order"),
      n.join("both"),
      n.output(f("nodes.both.output")),
    ],
    edges("start->a", "start->b", "a->both", "b->both", "both->end"),
  ),
);

describe("durable workflow runtime on memory adapters (#157)", () => {
  it("resumes from persisted state only and completes parallel paths through Join", async () => {
    const version = await publish(parallel);
    const started = await start(version, { user: "bob" });
    expect(started.status).toBe("waiting");
    const record = await load();
    expect(record.state.nodeRuns["root:a"]).toMatchObject({
      status: "waiting",
      waitingReason: "waiting_approval",
    });
    expect(record.state.effects["root:a#1"]?.reference).toBe("child:root:a#1");

    actions.resolve("root:a#1", "A");
    expect((await advance()).status).toBe("waiting");
    actions.resolve("root:b#1", "B");
    const done = await advance();
    expect(done.status).toBe("succeeded");
    expect((await load()).state.output).toEqual({ a: "A", b: "B" });
    expect(completion.delivered).toHaveLength(1);
    // 再度advanceしても親への通知は重複しない。
    await advance();
    expect(completion.delivered).toHaveLength(1);
  });

  it("does not duplicate child invocations after a crash between dispatch and save", async () => {
    const version = await publish(parallel);
    runs.failNextSaves = 1;
    const crashed = await runtime().start({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
      definitionId: version.definitionId,
      version: version.version,
      checksum: String(version.checksum),
      input: { user: "bob" },
      context: TEST_CONTEXT,
      invocation,
      depth: 0,
    });
    expect(Result.isFailure(crashed)).toBe(true);
    // 作用の予約は保存済み。再起動したruntimeは同じeffect IDで再配送する。
    expect(Object.keys((await load()).state.effects)).toEqual(["root:a#1", "root:b#1"]);
    await advance();
    await advance();
    expect([...actions.created.keys()]).toEqual(["root:a#1", "root:b#1"]);
    expect(new Set([...actions.created.values()].map(() => "child"))).toEqual(new Set(["child"]));
    const record = await load();
    expect(record.state.effects["root:a#1"]?.status).toBe("in_flight");
  });

  it("branch decision survives restarts and is not re-evaluated", async () => {
    const version = await publish(
      definition(
        graph(
          [
            n.trigger(),
            n.branch(
              "route",
              [{ key: "big", when: gt(f("workflow.input.amount"), lit(100)) }],
              "small",
            ),
            n.action("big_path", "payment.big"),
            n.action("small_path", "payment.small"),
            n.join("merge"),
            n.output(f("nodes.merge.output")),
          ],
          edges(
            "start->route",
            ["route", "big_path", "big"],
            ["route", "small_path", "small"],
            "big_path->merge",
            "small_path->merge",
            "merge->end",
          ),
        ),
      ),
    );
    await start(version, { amount: 500 });
    for (let index = 0; index < 3; index += 1) await advance();
    const record = await load();
    expect(record.state.decisions).toHaveLength(1);
    expect(Object.keys(record.state.effects)).toEqual(["root:big_path#1"]);
    actions.resolve("root:big_path#1", 1);
    expect((await advance()).status).toBe("succeeded");
  });

  it("empty ForEach completes immediately and iteration Join stays scoped (durably)", async () => {
    const body = graph(
      [
        n.action("left", "task.left", obj({ item: f("loop.item") })),
        n.action("right", "task.right", obj({ item: f("loop.item") })),
        n.join("pair"),
        n.output(f("nodes.pair.output"), "iter_end"),
      ],
      edges("left->pair", "right->pair", "pair->iter_end"),
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
    const empty = await start(version, { items: [] }, "run:empty");
    expect(empty.status).toBe("succeeded");
    expect((await load("run:empty")).state.output).toEqual([]);

    await start(version, { items: ["x", "y"] }, "run:items");
    actions.resolve("root/each[0]:left#1", "L0");
    actions.resolve("root/each[1]:right#1", "R1");
    await advance("run:items");
    let record = await load("run:items");
    expect(record.state.nodeRuns["root/each[0]:pair"]?.status).toBe("pending");
    expect(record.state.nodeRuns["root/each[1]:pair"]?.status).toBe("pending");
    actions.resolve("root/each[0]:right#1", "R0");
    actions.resolve("root/each[1]:left#1", "L1");
    expect((await advance("run:items")).status).toBe("succeeded");
    record = await load("run:items");
    expect(record.state.output).toEqual([
      { left: "L0", right: "R0" },
      { left: "L1", right: "R1" },
    ]);
  });

  it("unhandled child failure fails fast and propagates cancellation to in-flight children", async () => {
    const version = await publish(parallel);
    await start(version, { user: "bob" });
    actions.reject("root:a#1", "rejected");
    const result = await advance();
    expect(result.status).toBe("failed");
    const record = await load();
    expect(record.state.error?.code).toBe("rejected");
    expect(actions.cancelled).toEqual(["root:b#1"]);
    expect(record.state.effects["root:b#1"]).toMatchObject({
      status: "cancelled",
      cancelPropagated: true,
    });
    expect(completion.delivered.map((run) => run.state.status)).toEqual(["failed"]);
  });

  it("cancellation converges to cancelled and notifies the parent once", async () => {
    const version = await publish(parallel);
    await start(version, { user: "bob" });
    const cancelled = await runtime().cancel({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
      reason: "parent ActionRequest cancelled",
    });
    expect(Result.isSuccess(cancelled) && cancelled.value.status).toBe("cancelled");
    expect(actions.cancelled.sort()).toEqual(["root:a#1", "root:b#1"]);
    expect(completion.delivered).toHaveLength(1);
    const record = await load();
    expect(record.completionDelivered).toBe(true);
    expect(record.wakeAt).toBeUndefined();
  });

  it("retries parent notification until it succeeds", async () => {
    actions.immediate = true;
    const version = await publish(parallel);
    completion.failuresRemaining = 2;
    const first = await start(version, { user: "bob" });
    expect(first.status).toBe("succeeded");
    expect(first.wakeAt).toBeDefined();
    expect((await load()).completionDelivered).toBe(false);
    await advance();
    const final = await advance();
    expect(final.wakeAt).toBeUndefined();
    expect(completion.delivered).toHaveLength(1);
    const due = await runs.listDue({ now: "2027-01-01T00:00:00.000Z", limit: 10 });
    expect(Result.isSuccess(due) && due.value).toEqual([]);
  });

  it("timer and human-input effects wait without holding process memory", async () => {
    const program = {
      id: id("prog"),
      type: "program" as const,
      program: { programId: id("program:wait"), version: 1, sourceDigest: id("sha256:x") },
      input: obj({}),
    };
    const version = await publish(
      definition(
        graph(
          [n.trigger(), program as never, n.output(f("nodes.prog.output"))],
          edges("start->prog", "prog->end"),
        ),
      ),
    );
    const yields: EffectOutcomeReport[] = [
      { type: "yielded", state: { step: 1 }, effect: { type: "timer", seconds: 60 } },
      {
        type: "yielded",
        state: { step: 2 },
        effect: { type: "human_input", prompt: "承認コメント" },
      },
      { type: "completed", output: { finished: true } },
    ];
    const programHandler: EffectHandler = {
      async dispatch() {
        return Result.succeed(yields.shift() ?? { type: "failed", code: "x", message: "x" });
      },
    };
    const programRuntime = () =>
      new WorkflowRuntime({
        versions,
        runs,
        clock,
        effects: {
          program: programHandler,
          timer: new TimerEffectHandler(),
          human_input: new HumanInputEffectHandler(),
        },
      });
    const started = await programRuntime().start({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
      definitionId: version.definitionId,
      version: version.version,
      checksum: String(version.checksum),
      input: {},
      context: TEST_CONTEXT,
      invocation,
      depth: 0,
    });
    expect(Result.isSuccess(started) && started.value.wakeAt).toBe("2026-09-25T00:01:00.000Z");
    expect((await load()).state.nodeRuns["root:prog"]?.waitingReason).toBe("waiting_timer");
    clock.advance(61);
    await programRuntime().advance({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
    });
    const waitingInput = await load();
    expect(waitingInput.state.nodeRuns["root:prog"]?.waitingReason).toBe("waiting_input");
    const inputEffect = Object.values(waitingInput.state.effects).find(
      (effect) => effect.request.kind === "human_input",
    );
    const delivered = await programRuntime().deliver({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
      event: { type: "effect_completed", effectId: inputEffect?.id ?? id("x"), output: "OK" },
    });
    expect(Result.isSuccess(delivered) && delivered.value.status).toBe("succeeded");
    expect((await load()).state.output).toEqual({ finished: true });
  });

  it("pins the version checksum and rejects runaway nesting depth", async () => {
    const version = await publish(parallel);
    const mismatch = await runtime().start({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
      definitionId: version.definitionId,
      version: version.version,
      checksum: "sha256:other",
      input: {},
      context: TEST_CONTEXT,
      invocation,
      depth: 0,
    });
    expect(Result.isFailure(mismatch) && mismatch.error.code).toBe(
      "workflow_version_checksum_mismatch",
    );
    const deep = await runtime().start({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:2"),
      definitionId: version.definitionId,
      version: version.version,
      checksum: String(version.checksum),
      input: {},
      context: TEST_CONTEXT,
      invocation,
      depth: 6,
    });
    expect(Result.isFailure(deep) && deep.error.code).toBe("workflow_nesting_limit_exceeded");
  });

  it("records an append-only audit trail keyed by logical transition", async () => {
    actions.immediate = true;
    const version = await publish(parallel);
    await start(version, { user: "bob" });
    await advance();
    const events = await runs.listEvents({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:1"),
    });
    if (Result.isFailure(events)) expect.fail(events.error.message);
    const types = events.value.map((event) => event.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("effect.dispatched");
    expect(types.at(-1)).toBe("run.succeeded");
    expect(new Set(events.value.map((event) => event.eventKey)).size).toBe(events.value.length);
    // payloadにはoutputを含めない。
    expect(JSON.stringify(events.value)).not.toContain("done");
  });
});
