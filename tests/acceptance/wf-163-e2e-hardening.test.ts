import { readFileSync, readdirSync } from "node:fs";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ActionExecutionDispatch,
  ActionExecutionRequest,
  ActionExecutor,
  ActionFingerprint,
  ActionRequestId,
  OrganizationId,
} from "@app/approval-core";
import type { WorkflowDefinition, WorkflowRunId } from "@app/workflow-core";
import { DEFAULT_SANDBOX_LIMITS } from "@app/workflow-core";
import { definition, edges, eq, f, graph, id, lit, lt, n, obj } from "@app/workflow-core/testing";
import { QuickJsSandbox } from "@app/workflow-sandbox";
import { nodeQuickJsModule } from "@app/workflow-sandbox/node";

import { ALICE, ORG, createWorkflowHarness } from "../workflow/harness.ts";

/**
 * #163 Security / multi-tenant / durable E2E hardening。
 * WE-158〜161のacceptanceに加えて、制御フロー・crash / replay・async completion・
 * binding改ざん・executor bypass・audit相関をD1（SQLite）上のplatform全体で固定する。
 */

const PRIMITIVES = ["task.a", "task.b", "task.left", "task.right", "job.run", "payment.execute"];

function compositeOf(
  workflowId: string,
  nodes: Parameters<typeof graph>[0],
  edgeList: Parameters<typeof graph>[1],
): WorkflowDefinition {
  return definition(graph(nodes, edgeList), { id: id(workflowId), name: workflowId });
}

/** Branch -> A | B -> Join（all_active）-> Output。 */
const branchJoin = compositeOf(
  "wf:branch-join",
  [
    n.trigger(),
    n.branch("route", [{ key: "a", when: eq(f("workflow.input.kind"), lit("a")) }], "b"),
    n.action("a", "task.a", obj({ kind: f("workflow.input.kind") })),
    n.action("b", "task.b", obj({ kind: f("workflow.input.kind") })),
    n.join("merge"),
    n.output(f("nodes.merge.output")),
  ],
  edges(["start", "route"], ["route", "a", "a"], ["route", "b", "b"], "a->merge", "b->merge", [
    "merge",
    "end",
  ]),
);

/** ForEach（iteration-scoped Join）-> Output。 */
const perItem = compositeOf(
  "wf:per-item",
  [
    n.trigger(),
    n.forEach(
      "each",
      f("workflow.input.items"),
      graph(
        [
          n.transform("prep", f("loop.item")),
          n.action("left", "task.left", obj({ item: f("nodes.prep.output") })),
          n.action("right", "task.right", obj({ index: f("loop.index") })),
          n.join("pair"),
          n.output(
            obj({
              item: f("loop.item"),
              left: f("nodes.pair.output.left.input.item"),
              right: f("nodes.pair.output.right.input.index"),
            }),
            "iter_end",
          ),
        ],
        edges("prep->left", "prep->right", "left->pair", "right->pair", "pair->iter_end"),
      ),
      { concurrency: 2, maxItems: 10 },
    ),
    n.output(f("nodes.each.output")),
  ],
  edges("start->each", "each->end"),
);

/** accept後、外部で終わるjob（#165 async executor）。 */
class AsyncJobExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;
  readonly dispatched: ActionExecutionRequest[] = [];

  async execute() {
    return Result.succeed({ status: "succeeded" as const });
  }

  async dispatch(request: ActionExecutionRequest) {
    this.dispatched.push(structuredClone(request));
    const accepted: ActionExecutionDispatch = {
      type: "accepted",
      executionRef: `job:${String(request.actionRequestId)}`,
    };
    return Result.succeed(accepted);
  }
}

async function onlyChild(
  h: Awaited<ReturnType<typeof createWorkflowHarness>>,
  runId: WorkflowRunId,
) {
  const [child, ...rest] = await h.children(runId);
  assert(child);
  expect(rest).toEqual([]);
  return child;
}

describe("WE-163 control-flow semantics end to end (Composite Action on D1)", () => {
  it("Branch -> A|B -> Join waits only for the active path; the branch decision is durable across an approval wait", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("task.a");
    await h.publish(branchJoin, "route.run");

    const parent = await h.submit("route.run", { kind: "a" });
    await h.settle();
    let run = await h.runOf(parent.actionRequestId);
    expect(run.state.nodeRuns["root:a"]).toMatchObject({
      status: "waiting",
      waitingReason: "waiting_approval",
    });
    // 非選択pathはdurableにnot_taken。Bは作られず、Joinは待機中のAだけを待つ。
    expect(Object.values(run.state.edges)).toContain("not_taken");
    expect(run.state.nodeRuns["root:b"]?.status).toBe("skipped");
    expect(Object.values(run.state.effects).map((effect) => String(effect.nodeRunId))).toEqual([
      "root:a",
    ]);
    const decisions = run.state.decisions.filter((decision) => decision.kind === "branch");
    expect(decisions).toMatchObject([{ value: "a" }]);

    const child = await onlyChild(h, run.state.runId);
    await h.approve(child.childActionRequestId);
    run = await h.runOf(parent.actionRequestId);
    expect(run.state.status).toBe("succeeded");
    // resumeで再評価されない（決定は1回だけ、同じ時刻の記録のまま）。
    expect(run.state.decisions.filter((decision) => decision.kind === "branch")).toEqual(decisions);
    expect(await h.status(parent.actionRequestId)).toBe("executed");
    expect(await h.result(parent.actionRequestId)).toMatchObject({
      result: { output: { a: { input: { kind: "a" } } } },
    });
    expect(h.executor.calls.map((call) => String(call.action.type))).toEqual(["task.a"]);

    const other = await h.submit("route.run", { kind: "z" }, "res-2");
    await h.settle();
    expect(await h.status(other.actionRequestId)).toBe("executed");
    expect(h.executor.calls.map((call) => String(call.action.type))).toEqual(["task.a", "task.b"]);
  });

  it("ForEach runs parallel iterations with iteration-scoped Joins; empty ForEach succeeds with []", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(perItem, "items.process");

    const parent = await h.submit("items.process", { items: ["x", "y", "z"] });
    await h.settle();
    expect(await h.status(parent.actionRequestId)).toBe("executed");
    expect(await h.result(parent.actionRequestId)).toMatchObject({
      result: {
        output: [
          { item: "x", left: "x", right: 0 },
          { item: "y", left: "y", right: 1 },
          { item: "z", left: "z", right: 2 },
        ],
      },
    });
    const run = await h.runOf(parent.actionRequestId);
    const children = await h.children(run.state.runId);
    expect(children).toHaveLength(6);
    // 各iterationのchildは別NodeRun（iteration scope）に属し、混ざらない。
    expect(new Set(children.map((child) => String(child.nodeRunId))).size).toBe(6);
    expect(h.executor.calls).toHaveLength(6);

    const empty = await h.submit("items.process", { items: [] }, "res-empty");
    await h.settle();
    expect(await h.status(empty.actionRequestId)).toBe("executed");
    expect(await h.result(empty.actionRequestId)).toMatchObject({ result: { output: [] } });
    const emptyRun = await h.runOf(empty.actionRequestId);
    expect(await h.children(emptyRun.state.runId)).toEqual([]);
    expect(h.executor.calls).toHaveLength(6);

    const tooMany = await h.submit(
      "items.process",
      { items: Array.from({ length: 11 }, (_, index) => index) },
      "res-too-many",
    );
    await h.settle();
    expect(await h.status(tooMany.actionRequestId)).toBe("execution_failed");
    expect(await h.result(tooMany.actionRequestId)).toMatchObject({
      code: "for_each_too_many_items",
    });
  });

  it("While is bounded: a runaway loop fails the parent Action instead of spinning", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    const body = graph([n.transform("tick", f("loop.index"), { last: f("loop.index") })], []);
    await h.publish(
      compositeOf(
        "wf:bounded",
        [
          n.trigger(),
          n.while("loop", lt(f("loop.index"), lit(3)), body, 5),
          n.output(f("nodes.loop.output")),
        ],
        edges("start->loop", "loop->end"),
      ),
      "loop.bounded",
    );
    await h.publish(
      compositeOf(
        "wf:runaway",
        [n.trigger(), n.while("loop", eq(lit(1), lit(1)), body, 4), n.output(lit(null))],
        edges("start->loop", "loop->end"),
      ),
      "loop.runaway",
    );

    const bounded = await h.submit("loop.bounded", {});
    await h.settle();
    expect(await h.result(bounded.actionRequestId)).toMatchObject({
      status: "executed",
      result: { output: { iterations: 3 } },
    });

    const runaway = await h.submit("loop.runaway", {}, "res-runaway");
    await h.settle();
    expect(await h.status(runaway.actionRequestId)).toBe("execution_failed");
    expect(await h.result(runaway.actionRequestId)).toMatchObject({
      code: "while_max_iterations_exceeded",
    });
  });
});

describe("WE-163 durability: crash / retry / replay idempotency", () => {
  it("a crash after effect reservation re-dispatches the same effect once", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(branchJoin, "route.run");
    // parent自身のplan保存の次、child ActionRequestの作成（plan保存）がcommit前に落ちる。
    h.faults.crashOn("INSERT OR IGNORE INTO action_requests", { skip: 1 });

    const parent = await h.submit("route.run", { kind: "a" });
    expect(h.faults.crashes).toEqual(["INSERT OR IGNORE INTO action_requests"]);
    let run = await h.runOf(parent.actionRequestId);
    const effects = Object.values(run.state.effects);
    expect(effects).toHaveLength(1);
    // 予約済み（requested）のまま残り、外部side effectはまだ無い。
    expect(effects[0]?.status).toBe("requested");
    expect(h.executor.calls).toEqual([]);

    await h.settle();
    run = await h.runOf(parent.actionRequestId);
    expect(run.state.status).toBe("succeeded");
    const child = await onlyChild(h, run.state.runId);
    expect(String(child.effectId)).toBe(String(effects[0]?.id));
    expect(h.executor.calls.map((call) => String(call.actionRequestId))).toEqual([
      String(child.childActionRequestId),
    ]);
    expect(await h.status(parent.actionRequestId)).toBe("executed");
  });

  it("a crash after the child ActionRequest was created and executed does not duplicate it", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(branchJoin, "route.run");
    // childの実行後、WorkflowRun stateの保存（CAS update）がcommit前に落ちる。
    h.faults.crashOn("UPDATE workflow_runs");

    const parent = await h.submit("route.run", { kind: "b" });
    expect(h.faults.crashes).toEqual(["UPDATE workflow_runs"]);
    expect(h.executor.calls).toHaveLength(1);
    let run = await h.runOf(parent.actionRequestId);
    // 保存済みstateでは作用は予約のまま（childの結果はまだrunへ反映されていない）。
    expect(Object.values(run.state.effects).map((effect) => effect.status)).toEqual(["requested"]);

    await h.settle();
    run = await h.runOf(parent.actionRequestId);
    expect(run.state.status).toBe("succeeded");
    const child = await onlyChild(h, run.state.runId);
    // 再配送は決定的なchild IDで既存のActionRequestへ収束し、executorは1回しか呼ばれない。
    expect(h.executor.calls.map((call) => String(call.actionRequestId))).toEqual([
      String(child.childActionRequestId),
    ]);
    expect(await h.status(parent.actionRequestId)).toBe("executed");
  });

  it("concurrent advances and redelivered parent submissions converge on a single run and single children", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("task.left");
    await h.publish(perItem, "items.process");
    const parent = await h.submit("items.process", { items: ["x", "y"] });
    const run = await h.runOf(parent.actionRequestId);
    const key = { organizationId: ORG, runId: run.state.runId };

    await Promise.all([h.platform.runtime.advance(key), h.platform.runtime.advance(key)]);
    await h.settle();
    const children = await h.children(run.state.runId);
    expect(children).toHaveLength(4);
    const waiting = children.filter((child) => String(child.actionType) === "task.left");
    expect(waiting).toHaveLength(2);
    for (const child of waiting) await h.approve(child.childActionRequestId);
    // 承認後の重複advanceも既存の状態へ収束する。
    await Promise.all([h.platform.runtime.advance(key), h.platform.runtime.advance(key)]);
    await h.settle();

    expect(await h.status(parent.actionRequestId)).toBe("executed");
    expect(h.executor.calls).toHaveLength(4);
    expect(new Set(h.executor.calls.map((call) => String(call.actionRequestId))).size).toBe(4);
    const events = await h.events(parent.actionRequestId);
    expect(events.filter((record) => record.event.type === "action.completed")).toHaveLength(1);
  });
});

describe("WE-163 async Action accepted -> completion lifecycle", () => {
  it("keeps the child executing until a trusted, bound completion; rejects spoofed / stale / conflicting completions", async () => {
    const jobs = new AsyncJobExecutor();
    const h = await createWorkflowHarness({
      primitiveActionTypes: PRIMITIVES,
      platform: { primitiveExecutors: { primitive: jobs } },
    });
    await h.publish(
      compositeOf(
        "wf:job",
        [
          n.trigger(),
          n.action("job", "job.run", obj({ n: lit(1) })),
          n.output(f("nodes.job.output")),
        ],
        edges("start->job", "job->end"),
      ),
      "job.composite",
    );
    const parent = await h.submit("job.composite", {});
    await h.settle();
    const run = await h.runOf(parent.actionRequestId);
    const child = await onlyChild(h, run.state.runId);
    const childId = child.childActionRequestId;
    expect(jobs.dispatched).toHaveLength(1);
    // accepted は完了ではない。child / parentともexecutingで待つ。
    expect(await h.status(childId)).toBe("executing");
    expect(await h.status(parent.actionRequestId)).toBe("executing");
    expect(run.state.nodeRuns["root:job"]?.status).toBe("waiting");

    const accepted = await h.platform.repositories.asyncExecutions.load({
      organizationId: ORG,
      actionRequestId: childId,
    });
    assert(Result.isSuccess(accepted) && accepted.value);
    const genuine = {
      organizationId: ORG,
      actionRequestId: childId,
      actionFingerprint: accepted.value.actionFingerprint,
      executionRef: accepted.value.executionRef,
      idempotencyKey: accepted.value.idempotencyKey,
      completion: { status: "executed" as const, output: { done: true } },
      completedAt: h.clock.now(),
    };
    const completion = h.platform.completion;

    const spoofs = [
      { ...genuine, actionFingerprint: id<ActionFingerprint>("sha256:forged") },
      { ...genuine, executionRef: "job:someone-else" },
      { ...genuine, idempotencyKey: "stale-attempt" },
    ];
    for (const spoof of spoofs) {
      const rejected = await completion.complete(spoof);
      expect(Result.isFailure(rejected) && rejected.error.code).toBe("completion_binding_mismatch");
    }
    const crossTenant = await completion.complete({
      ...genuine,
      organizationId: id<OrganizationId>("org:intruder"),
    });
    expect(Result.isFailure(crossTenant) && crossTenant.error.code).toBe("execution_not_accepted");
    const neverAccepted = await completion.complete({
      ...genuine,
      actionRequestId: id<ActionRequestId>("action:never-dispatched"),
    });
    expect(Result.isFailure(neverAccepted) && neverAccepted.error.code).toBe(
      "execution_not_accepted",
    );
    await h.settle();
    expect(await h.status(childId)).toBe("executing");

    const completed = await completion.complete(genuine);
    expect(Result.isSuccess(completed) && completed.value.type).toBe("completed");
    const replayed = await completion.complete(genuine);
    expect(Result.isSuccess(replayed) && replayed.value.type).toBe("replayed");
    const conflicting = await completion.complete({
      ...genuine,
      completion: { status: "execution_failed", code: "late_failure", message: "late" },
    });
    expect(Result.isFailure(conflicting) && conflicting.error.code).toBe("completion_conflict");

    await h.settle();
    expect(await h.status(childId)).toBe("executed");
    expect(await h.status(parent.actionRequestId)).toBe("executed");
    expect(await h.result(parent.actionRequestId)).toMatchObject({
      result: { output: { done: true } },
    });
    const rejections = (await h.events(childId)).filter(
      (record) => record.event.type === "action.execution_completion_rejected",
    );
    // 拒否は監査に残る（同じexecutionRef / codeの再送は1件に冪等化される）。
    expect(
      rejections.map((record) =>
        record.event.type === "action.execution_completion_rejected"
          ? [record.event.executionRef, record.event.code]
          : [],
      ),
    ).toEqual([
      [genuine.executionRef, "completion_binding_mismatch"],
      ["job:someone-else", "completion_binding_mismatch"],
      [genuine.executionRef, "completion_conflict"],
    ]);
  });
});

describe("WE-163 security regression", () => {
  it("the sandbox has no network, module, process, or host globals even when accessed indirectly", async () => {
    const sandbox = new QuickJsSandbox(nodeQuickJsModule);
    const probed = await sandbox.run({
      source: `function main() {
        const g = globalThis;
        const names = [["fe", "tch"], ["XMLHttp", "Request"], ["Web", "Socket"], ["pro", "cess"],
          ["req", "uire"], ["Deno"], ["Bun"], ["navigator"], ["setTimeout"], ["import", "Scripts"]];
        const found = {};
        for (const parts of names) found[parts.join("")] = typeof g[parts.join("")];
        return ue.complete({ found });
      }`,
      input: null,
      limits: DEFAULT_SANDBOX_LIMITS,
    });
    assert(Result.isSuccess(probed));
    assert(probed.value.result.type === "complete");
    const output = probed.value.result.output as { found: Record<string, string> };
    expect(Object.entries(output.found).filter(([, type]) => type !== "undefined")).toEqual([]);
  });

  it("WorkflowVersion / binding substitution is impossible: stored versions and bindings are immutable", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(branchJoin, "route.run");
    await h.submit("route.run", { kind: "b" });
    await h.settle();
    const sqlite = h.db.db;
    expect(() => sqlite.exec(`UPDATE workflow_versions SET version_json = '{}'`)).toThrow(
      /immutable/,
    );
    expect(() => sqlite.exec(`UPDATE workflow_action_bindings SET workflow_version = 99`)).toThrow(
      /immutable/,
    );
    expect(() => sqlite.exec(`DELETE FROM workflow_action_bindings`)).toThrow(/immutable/);
    expect(() => sqlite.exec(`UPDATE workflow_events SET event_json = '{}'`)).toThrow(
      /append-only/,
    );
  });

  it("revoking authorization while a child waits for approval blocks execution at re-authorization", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("payment.execute");
    await h.publish(
      compositeOf(
        "wf:pay-revoked",
        [
          n.trigger(),
          n.action("pay", "payment.execute", obj({ amount: lit(1) })),
          n.output(f("nodes.pay.output")),
        ],
        edges("start->pay", "pay->end"),
      ),
      "expense.revocable",
    );
    const parent = await h.submit("expense.revocable", {});
    await h.settle();
    const child = await onlyChild(h, (await h.runOf(parent.actionRequestId)).state.runId);
    expect(await h.status(child.childActionRequestId)).toBe("pending_approval");

    // 承認待ちの間に権限が失効した。承認されても実行前の再認可で止まる。
    h.authorizer.denied.add("payment.execute");
    await h.approve(child.childActionRequestId);
    expect(await h.status(child.childActionRequestId)).toBe("authorization_revoked");
    expect(h.executor.calls).toEqual([]);
    expect(await h.status(parent.actionRequestId)).toBe("execution_failed");
    expect(await h.result(parent.actionRequestId)).toMatchObject({ code: "authorization_revoked" });
  });

  it("the Workflow executor cannot be invoked directly without a materialized ActionRequest", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(branchJoin, "route.run");
    const legit = await h.submit("route.run", { kind: "b" });
    await h.settle();
    const plan = await h.loadPlan(legit.actionRequestId);

    const forgedId = id<ActionRequestId>("action:forged");
    const forged = await h.platform.registry.dispatch({
      organizationId: ORG,
      actionRequestId: forgedId,
      actionFingerprint: plan.actionFingerprint,
      idempotencyKey: "forged",
      action: plan.action,
      authorizationEvidence: {
        evaluatedAt: h.clock.now(),
        consistency: "higher_consistency",
        provider: "forged",
      },
      actor: ALICE,
    });
    expect(Result.isFailure(forged)).toBe(true);
    const run = await h.platform.repositories.runs.findByParentAction({
      organizationId: ORG,
      actionRequestId: forgedId,
    });
    expect(Result.isSuccess(run) && run.value).toBeNull();
    expect(h.executor.calls).toHaveLength(1);
  });

  it("does not leak action inputs or secrets into the workflow audit stream", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(branchJoin, "route.run");
    const secret = "sk-live-SECRET-MARKER-163";
    const parent = await h.submit("route.run", { kind: "b", apiKey: secret });
    await h.settle();
    expect(await h.status(parent.actionRequestId)).toBe("executed");
    const rows = h.db.db.prepare(`SELECT * FROM workflow_events`).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

describe("WE-163 architecture boundary", () => {
  it("keeps MCP-specific concepts out of workflow-core / approval-core Action model and the workflow engine", () => {
    const root = new URL("../../packages/", import.meta.url);
    for (const name of [
      "workflow-core",
      "workflow-application",
      "expression-core",
      "approval-core",
    ]) {
      const manifest = JSON.parse(readFileSync(new URL(`${name}/package.json`, root), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.includes("mcp"))).toEqual(
        [],
      );
    }
    const sourcesOf = (directory: string) =>
      readdirSync(new URL(directory, root), { recursive: true })
        .map((file) => new URL(`${directory}${String(file)}`, root))
        .filter(
          (file) => file.pathname.endsWith(".ts") && !/\.(type-)?test\.ts$/.test(file.pathname),
        )
        .map((file) => ({
          file: file.pathname,
          code: readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, ""),
        }));
    // workflow engineのdefinition / kernel / runtimeはMCPを一切知らない（Actionだけを扱う）。
    const engine = [
      ...sourcesOf("workflow-core/src/"),
      ...sourcesOf("workflow-application/src/"),
      ...sourcesOf("expression-core/src/"),
    ];
    expect(engine.length).toBeGreaterThan(0);
    expect(
      engine.filter((source) => /mcp/i.test(source.code)).map((source) => source.file),
    ).toEqual([]);
    // approval-coreのAction modelはMCP packageに依存しない（originの"mcp"は入口channelのlabelだけ）。
    const actionModel = sourcesOf("approval-core/src/domain/");
    expect(
      actionModel
        .filter((source) => /from\s+["'][^"']*mcp[^"']*["']|\bMcp[A-Z]\w*/.test(source.code))
        .map((source) => source.file),
    ).toEqual([]);
  });
});

describe("WE-163 audit correlation", () => {
  it("correlates parent ActionRequest -> WorkflowRun -> NodeRun -> Effect -> child ActionRequest -> Approval -> Executor", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("payment.execute");
    await h.publish(
      compositeOf(
        "wf:pay",
        [
          n.trigger(),
          n.action("pay", "payment.execute", obj({ amount: f("workflow.input.amount") })),
          n.output(f("nodes.pay.output.input")),
        ],
        edges("start->pay", "pay->end"),
      ),
      "expense.reimburse",
    );
    const parent = await h.submit("expense.reimburse", { amount: 5000 });
    await h.settle();
    const run = await h.runOf(parent.actionRequestId);
    const child = await onlyChild(h, run.state.runId);
    await h.approve(child.childActionRequestId);

    // parent ActionRequest -> WorkflowRun
    const finished = await h.runById(run.state.runId);
    expect(String(finished.invocation.parentAction?.actionRequestId)).toBe(
      String(parent.actionRequestId),
    );
    // WorkflowRun -> NodeRun -> Effect -> child ActionRequest
    expect(String(child.parentActionRequestId)).toBe(String(parent.actionRequestId));
    const nodeRun = finished.state.nodeRuns[String(child.nodeRunId)];
    expect(nodeRun?.nodeId).toBe("pay");
    const effect = finished.state.effects[String(child.effectId)];
    expect(effect?.nodeRunId).toBe(child.nodeRunId);
    expect(effect?.reference).toBe(String(child.childActionRequestId));
    // child ActionRequest -> Approval -> Executor
    const childEvents = (await h.events(child.childActionRequestId)).map(
      (record) => record.event.type,
    );
    expect(childEvents).toEqual(
      expect.arrayContaining(["action.received", "approval.approved", "action.completed"]),
    );
    expect(h.executor.calls.map((call) => String(call.actionRequestId))).toEqual([
      String(child.childActionRequestId),
    ]);
    // child planはworkflow originとrun IDを持つ（監査からrunへ戻れる）。
    const childPlan = await h.loadPlan(child.childActionRequestId);
    expect(childPlan.evaluationSnapshot.origin).toMatchObject({
      type: "system",
      agentRunId: String(run.state.runId),
    });
    // 同じ相関を1つのtraceとして辿れる。
    const trace = await h.platform.trace(parent.actionRequestId);
    expect(trace).toMatchObject({
      actionRequestId: String(parent.actionRequestId),
      status: "executed",
      run: {
        runId: String(run.state.runId),
        status: "succeeded",
        nodeRuns: expect.arrayContaining([
          expect.objectContaining({
            nodeId: "pay",
            childActions: [
              expect.objectContaining({
                actionRequestId: String(child.childActionRequestId),
                status: "executed",
                approval: { required: true, source: "materialized_plan" },
              }),
            ],
          }),
        ]),
      },
    });
  });
});
