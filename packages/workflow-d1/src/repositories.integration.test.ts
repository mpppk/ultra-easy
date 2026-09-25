import { Result } from "@praha/byethrow";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { migratedSqliteD1 } from "@app/approval-d1/testing";
import type { SqliteD1Database } from "@app/approval-d1/testing";
import { WorkflowRuntime } from "@app/workflow-application";
import type {
  EffectHandler,
  EffectOutcomeReport,
  WorkflowInvocation,
} from "@app/workflow-application";
import { publishWorkflowVersion } from "@app/workflow-core";
import type { WorkflowRunId, WorkflowVersion } from "@app/workflow-core";
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

import type { D1DatabaseLike } from "./d1.ts";
import {
  D1WorkflowDraftRepository,
  D1WorkflowRunRepository,
  D1WorkflowVersionRepository,
} from "./repositories.ts";

const NOW = "2026-09-25T00:00:00.000Z";
const invocation: WorkflowInvocation = {
  actor: TEST_ACTOR,
  authority: { principal: TEST_ACTOR },
  origin: { type: "system" },
};

let sqlite: SqliteD1Database;
let db: D1DatabaseLike;
let created: Map<string, number>;
let results: Map<string, EffectOutcomeReport>;

const actionHandler: EffectHandler = {
  async dispatch(context) {
    const effectId = String(context.effect.id);
    created.set(effectId, (created.get(effectId) ?? 0) + 1);
    return Result.succeed({
      type: "in_flight",
      waitingReason: "waiting_approval",
      reference: `child:${effectId}`,
    });
  },
  async poll(context) {
    return Result.succeed(
      results.get(String(context.effect.id)) ?? {
        type: "in_flight",
        waitingReason: "waiting_approval",
      },
    );
  },
};

function runtime(): WorkflowRuntime {
  return new WorkflowRuntime({
    versions: new D1WorkflowVersionRepository(db),
    runs: new D1WorkflowRunRepository(db),
    clock: { now: () => NOW },
    effects: { action: actionHandler },
  });
}

async function publish(): Promise<WorkflowVersion> {
  const published = await publishWorkflowVersion({
    definition: definition(
      graph(
        [
          n.trigger(),
          n.action("a", "task.a", obj({ user: f("workflow.input.user") })),
          n.action("b", "task.b"),
          n.join("both"),
          n.output(f("nodes.both.output")),
        ],
        edges("start->a", "start->b", "a->both", "b->both", "both->end"),
      ),
    ),
    latestVersion: null,
    publishedAt: NOW,
    publishedBy: TEST_ACTOR,
  });
  if (Result.isFailure(published)) expect.fail(published.error.message);
  const saved = await new D1WorkflowVersionRepository(db).save({
    organizationId: TEST_ORGANIZATION_ID,
    version: published.value,
  });
  expect(Result.isSuccess(saved) && saved.value.type).toBe("created");
  return published.value;
}

async function start(version: WorkflowVersion) {
  return runtime().start({
    organizationId: TEST_ORGANIZATION_ID,
    runId: id<WorkflowRunId>("run:d1"),
    definitionId: version.definitionId,
    version: version.version,
    checksum: String(version.checksum),
    input: { user: "bob" },
    context: TEST_CONTEXT,
    invocation,
    depth: 0,
  });
}

beforeEach(() => {
  sqlite = migratedSqliteD1();
  db = sqlite as unknown as D1DatabaseLike;
  created = new Map();
  results = new Map();
});

describe("D1 workflow persistence (#157)", () => {
  it("runs a workflow to completion across fresh runtime instances", async () => {
    const version = await publish();
    const started = await start(version);
    expect(Result.isSuccess(started) && started.value.status).toBe("waiting");
    results.set("root:a#1", { type: "completed", output: "A" });
    results.set("root:b#1", { type: "completed", output: "B" });
    const done = await runtime().advance({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:d1"),
    });
    expect(Result.isSuccess(done) && done.value.status).toBe("succeeded");
    const record = await new D1WorkflowRunRepository(db).load({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:d1"),
    });
    expect(Result.isSuccess(record) && record.value?.state.output).toEqual({ a: "A", b: "B" });
    expect([...created.values()]).toEqual([1, 1]);
  });

  it("crash before the state batch commits re-dispatches with the same effect ids", async () => {
    const version = await publish();
    // create（1 batch目）は成功、dispatch後のsave（2 batch目）で落ちる。
    sqlite.failNextBatchAt = 2;
    const crashed = await start(version);
    expect(Result.isFailure(crashed)).toBe(true);
    const again = await runtime().advance({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:d1"),
    });
    expect(Result.isSuccess(again) && again.value.status).toBe("waiting");
    expect([...created.keys()].sort()).toEqual(["root:a#1", "root:b#1"]);
    const events = await new D1WorkflowRunRepository(db).listEvents({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:d1"),
    });
    if (Result.isFailure(events)) expect.fail(events.error.message);
    const dispatched = events.value.filter((event) => event.type === "effect.dispatched");
    expect(
      dispatched.map((event) => String(event.effectId)).sort((l, r) => l.localeCompare(r)),
    ).toEqual(["root:a#1", "root:b#1"]);
  });

  it("CAS rejects a stale writer and does not record its audit events", async () => {
    const version = await publish();
    await start(version);
    const repository = new D1WorkflowRunRepository(db);
    const loaded = await repository.load({
      organizationId: TEST_ORGANIZATION_ID,
      runId: id<WorkflowRunId>("run:d1"),
    });
    if (Result.isFailure(loaded) || !loaded.value) expect.fail("missing run");
    const record = loaded.value;
    const staleEvent = {
      organizationId: TEST_ORGANIZATION_ID,
      runId: record.state.runId,
      eventKey: "stale-writer-event",
      type: "run.failed" as const,
      occurredAt: NOW,
      data: {},
    };
    const first = await repository.save({ record, expectedRevision: record.revision, events: [] });
    expect(Result.isSuccess(first) && first.value.type).toBe("saved");
    const stale = await repository.save({
      record,
      expectedRevision: record.revision,
      events: [staleEvent],
    });
    expect(Result.isSuccess(stale) && stale.value.type).toBe("conflict");
    const events = await repository.listEvents({
      organizationId: TEST_ORGANIZATION_ID,
      runId: record.state.runId,
    });
    expect(
      Result.isSuccess(events) &&
        events.value.some((event) => event.eventKey === "stale-writer-event"),
    ).toBe(false);
  });

  it("workflow versions are immutable and audit events are append-only in the database", async () => {
    const version = await publish();
    const repository = new D1WorkflowVersionRepository(db);
    const tampered = { ...version, checksum: id<typeof version.checksum>("sha256:different") };
    const conflict = await repository.save({
      organizationId: TEST_ORGANIZATION_ID,
      version: tampered,
    });
    expect(Result.isFailure(conflict) && conflict.error.code).toBe("workflow_version_conflict");
    expect(() => sqlite.db.exec("UPDATE workflow_versions SET checksum = 'x'")).toThrow(
      /immutable/,
    );
    await start(version);
    expect(() => sqlite.db.exec("DELETE FROM workflow_events")).toThrow(/append-only/);
    const latest = await repository.latest({
      organizationId: TEST_ORGANIZATION_ID,
      definitionId: version.definitionId,
    });
    expect(Result.isSuccess(latest) && latest.value?.checksum).toBe(version.checksum);
  });

  it("lists due runs for the durable sweeper and stores drafts with optimistic revisions", async () => {
    const version = await publish();
    await start(version);
    const due = await new D1WorkflowRunRepository(db).listDue({
      now: "2027-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(Result.isSuccess(due) && due.value.map((key) => String(key.runId))).toEqual(["run:d1"]);

    const drafts = new D1WorkflowDraftRepository(db);
    const first = await drafts.save({
      organizationId: TEST_ORGANIZATION_ID,
      definition: version.definition,
      expectedRevision: null,
      updatedAt: NOW,
    });
    expect(Result.isSuccess(first) && first.value).toEqual({ type: "saved", revision: 1 });
    const stale = await drafts.save({
      organizationId: TEST_ORGANIZATION_ID,
      definition: version.definition,
      expectedRevision: null,
      updatedAt: NOW,
    });
    expect(Result.isSuccess(stale) && stale.value.type).toBe("conflict");
    const listed = await drafts.list({ organizationId: TEST_ORGANIZATION_ID });
    expect(Result.isSuccess(listed) && listed.value.map((draft) => draft.revision)).toEqual([1]);
  });
});
