import { Result } from "@praha/byethrow";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";

import { D1WorkflowRunRepository, D1WorkflowVersionRepository } from "@app/workflow-d1";
import type { WorkflowInvocation } from "@app/workflow-application";
import { publishWorkflowVersion } from "@app/workflow-core";
import type { WorkflowNode, WorkflowRunId, WorkflowVersion } from "@app/workflow-core";
import {
  TEST_ACTOR,
  TEST_CONTEXT,
  TEST_ORGANIZATION_ID,
  definition,
  edges,
  f,
  graph,
  id,
  n,
  obj,
} from "@app/workflow-core/testing";

import {
  CloudflareWorkflowRunnerControl,
  sweepDueWorkflowRuns,
  workflowRunnerInstanceId,
} from "./runner.ts";
import { testWorkflowRuntime } from "./testing/test-worker.ts";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const invocation: WorkflowInvocation = {
  actor: TEST_ACTOR,
  authority: { principal: TEST_ACTOR },
  origin: { type: "system" },
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

async function publish(
  nodes: WorkflowNode[],
  edgeSpec: string[],
  definitionId: string,
): Promise<WorkflowVersion> {
  const published = await publishWorkflowVersion({
    definition: { ...definition(graph(nodes, edges(...edgeSpec))), id: id(definitionId) },
    latestVersion: null,
    publishedAt: new Date().toISOString(),
    publishedBy: TEST_ACTOR,
  });
  if (Result.isFailure(published)) expect.fail(published.error.message);
  await new D1WorkflowVersionRepository(testEnv.DB).save({
    organizationId: TEST_ORGANIZATION_ID,
    version: published.value,
  });
  return published.value;
}

async function startRun(version: WorkflowVersion, runId: string) {
  return testWorkflowRuntime({ DB: testEnv.DB }).start({
    organizationId: TEST_ORGANIZATION_ID,
    runId: id<WorkflowRunId>(runId),
    definitionId: version.definitionId,
    version: version.version,
    checksum: String(version.checksum),
    input: { user: "bob" },
    context: TEST_CONTEXT,
    invocation,
    depth: 0,
  });
}

const programNode = {
  id: id("prog"),
  type: "program" as const,
  program: { programId: id("program:ask"), version: 1, sourceDigest: id("sha256:ask") },
  input: obj({}),
} as WorkflowNode;

describe("Cloudflare durable workflow runner (#157)", () => {
  it("waits on a Cloudflare Workflow without process memory and resumes on the resume event", async () => {
    const version = await publish(
      [
        n.trigger(),
        programNode,
        n.action("notify", "task.notify"),
        n.output(obj({ prog: f("nodes.prog.output"), notify: f("nodes.notify.output") })),
      ],
      ["start->prog", "prog->notify", "notify->end"],
      "wf:runner-human-input",
    );
    const runId = id<WorkflowRunId>("run:runner-1");
    const started = await startRun(version, String(runId));
    expect(Result.isSuccess(started) && started.value.status).toBe("waiting");

    const params = { organizationId: TEST_ORGANIZATION_ID, runId };
    const instanceId = await workflowRunnerInstanceId(params);
    await using instance = await introspectWorkflowInstance(testEnv.WORKFLOW_RUNNER, instanceId);
    const control = new CloudflareWorkflowRunnerControl(testEnv.WORKFLOW_RUNNER);
    await control.start(params);

    const runs = new D1WorkflowRunRepository(testEnv.DB);
    const waiting = await runs.load(params);
    if (Result.isFailure(waiting) || !waiting.value) expect.fail("run missing");
    expect(waiting.value.state.nodeRuns["root:prog"]?.waitingReason).toBe("waiting_input");
    const inputEffect = Object.values(waiting.value.state.effects).find(
      (effect) => effect.request.kind === "human_input",
    );

    // human inputはtrusted API（deliver）で届け、runnerはresume eventで起こす。
    const delivered = await testWorkflowRuntime({ DB: testEnv.DB }).deliver({
      ...params,
      event: { type: "effect_completed", effectId: inputEffect?.id ?? id("x"), output: "approved" },
    });
    expect(Result.isSuccess(delivered) && delivered.value.status).toBe("succeeded");
    await control.resume(params);

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ type: "completed", status: "succeeded" });
    const done = await runs.load(params);
    if (Result.isFailure(done) || !done.value) expect.fail("run missing");
    expect(done.value.state.output).toEqual({
      prog: { input: "approved" },
      notify: { done: "root:notify#1" },
    });
    expect(done.value.completionDelivered).toBe(true);
  });

  it("the cron sweeper advances due runs directly from D1", async () => {
    const version = await publish(
      [n.trigger(), programNode, n.output(f("nodes.prog.output"))],
      ["start->prog", "prog->end"],
      "wf:runner-sweeper",
    );
    const runId = id<WorkflowRunId>("run:sweeper-1");
    await startRun(version, String(runId));
    const runs = new D1WorkflowRunRepository(testEnv.DB);
    const loaded = await runs.load({ organizationId: TEST_ORGANIZATION_ID, runId });
    if (Result.isFailure(loaded) || !loaded.value) expect.fail("run missing");
    const inputEffect = Object.values(loaded.value.state.effects).find(
      (effect) => effect.request.kind === "human_input",
    );
    // 入力を直接D1へ反映しただけ（runtimeを起こさない）の状態を、sweeperが拾って進める。
    const runtime = testWorkflowRuntime({ DB: testEnv.DB });
    await runtime.deliver({
      organizationId: TEST_ORGANIZATION_ID,
      runId,
      event: { type: "effect_completed", effectId: inputEffect?.id ?? id("x"), output: 42 },
    });
    const swept = await sweepDueWorkflowRuns({
      runs,
      runtime,
      now: "2099-01-01T00:00:00.000Z",
    });
    expect(Result.isSuccess(swept)).toBe(true);
    const done = await runs.load({ organizationId: TEST_ORGANIZATION_ID, runId });
    expect(Result.isSuccess(done) && done.value?.state.status).toBe("succeeded");
    expect(Result.isSuccess(done) && done.value?.state.output).toEqual({ input: 42 });
  });
});
