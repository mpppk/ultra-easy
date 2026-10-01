import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { StartActionInput } from "../client.ts";
import { RemoteWorkflowClient } from "./workflow.ts";

const organizationId = "organization:staging";
const baseUrl = "https://approval-api.internal";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run:one",
    actionRequestId: "ar:one",
    actionType: "knowledge.publish_document",
    organizationId,
    status: "waiting_input",
    correlation: { spaceId: "space:one", pageId: "page:one" },
    requestedBy: { id: "user:alice", displayName: "user:alice" },
    startedAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T01:00:00Z",
    nodes: [{ key: "start", label: "Start", status: "succeeded" }],
    childActions: [
      {
        actionRequestId: "ar:child",
        actionType: "knowledge.page.archive",
        status: "waiting_approval",
        subjectResourceId: "page:one",
      },
    ],
    approvals: [],
    humanInputs: [
      { key: "effect:other", status: "waiting" },
      {
        key: "effect:mine",
        status: "waiting",
        assigneeId: "user:alice",
        prompt: "Archive?",
        subject: { type: "knowledge_page", id: "page:one", title: "Page One" },
        options: ["keep", "archive"],
        analysis: "May be stale",
      },
    ],
    failure: null,
    audit: [
      {
        at: "2026-09-30T00:00:00Z",
        type: "action.received",
        actionRequestId: "ar:one",
        detail: "action.received",
      },
    ],
    ...overrides,
  };
}

function client(send: (request: Request) => Promise<Response>) {
  return new RemoteWorkflowClient({
    baseUrl,
    organizationId,
    principalId: "user:alice",
    accessToken: "verified-user-token",
    send,
  });
}

function action(
  actionType: StartActionInput["actionType"] = "knowledge.publish_document",
): StartActionInput {
  return {
    organizationId,
    actor: { id: "user:alice", displayName: "Alice" },
    actionType,
    resource: { type: "knowledge_page", id: "page:one" },
    input: { publicationSnapshotId: "pub:one" },
    correlation: { spaceId: "space:one", pageId: "page:one", publicationSnapshotId: "pub:one" },
    idempotencyKey: "publish:pub:one",
  };
}

describe("Knowledge remote workflow client (#216)", () => {
  it("submits the catalog's space resource and returns a linked run", async () => {
    const seen: Request[] = [];
    const remote = client(async (request) => {
      seen.push(request);
      if (request.method === "POST")
        return Response.json(
          { id: "ar:one", organizationId, actor: { id: "user:alice" }, status: "executing" },
          { status: 201 },
        );
      return Response.json(run());
    });
    const started = await remote.startAction(action());
    expect(Result.isSuccess(started)).toBe(true);
    if (Result.isFailure(started)) return;
    expect(started.value).toMatchObject({
      actionRequestId: "ar:one",
      status: "waiting_input",
      run: { id: "run:one" },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer verified-user-token");
    expect(seen[0]?.headers.get("idempotency-key")).toBe("publish:pub:one");
    expect(await seen[0]?.json()).toMatchObject({
      action: {
        type: "knowledge.publish_document",
        resource: { type: "knowledge_space", id: "space:one" },
        input: { spaceId: "space:one", publicationSnapshotId: "pub:one" },
      },
      correlation: { spaceId: "space:one", pageId: "page:one" },
    });
    expect(seen[1]?.url).toContain("/action-requests/ar%3Aone/workflow-run");
  });

  it("represents an approved action with no run and finds its pending task", async () => {
    const remote = client(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST")
        return Response.json(
          { id: "ar:one", organizationId, actor: { id: "user:alice" }, status: "pending_approval" },
          { status: 201 },
        );
      if (path.endsWith("/workflow-run"))
        return Response.json({ code: "workflow_run_not_found" }, { status: 404 });
      return Response.json({ items: [{ id: "task:one", status: "pending" }] });
    });
    const started = await remote.startAction(action());
    expect(started).toEqual(
      Result.succeed({
        actionRequestId: "ar:one",
        run: null,
        status: "waiting_approval",
        approvalUrl: `${baseUrl}/v1/organizations/organization%3Astaging/approval-tasks/task%3Aone`,
      }),
    );
  });

  it("accepts a primitive action without inventing a workflow run", async () => {
    const paths: string[] = [];
    let body: unknown;
    const remote = client(async (request) => {
      paths.push(new URL(request.url).pathname);
      body = await request.json();
      return Response.json(
        { id: "ar:one", organizationId, actor: { id: "user:alice" }, status: "executed" },
        { status: 201 },
      );
    });
    const started = await remote.startAction(action("knowledge.search.reindex"));
    expect(started).toEqual(
      Result.succeed({
        actionRequestId: "ar:one",
        run: null,
        status: "succeeded",
        approvalUrl: null,
      }),
    );
    expect(paths).toHaveLength(1);
    expect(body).toMatchObject({ action: { input: { publicationSnapshotId: "pub:one" } } });
    expect(
      (body as { action: { input: Record<string, unknown> } }).action.input,
    ).not.toHaveProperty("spaceId");
  });

  it("maps public runs and drops redacted or foreign Human Inputs", async () => {
    const remote = client(async () => Response.json(run()));
    const loaded = await remote.getRun({ organizationId, runId: "run:one" });
    expect(Result.isSuccess(loaded)).toBe(true);
    if (Result.isFailure(loaded)) return;
    expect(loaded.value?.humanInputs).toEqual([
      {
        key: "effect:mine",
        status: "waiting",
        assigneeId: "user:alice",
        subject: { pageId: "page:one", title: "Page One" },
        prompt: "Archive?",
        options: ["keep", "archive"],
        analysis: "May be stale",
      },
    ]);
    expect(loaded.value?.childActions[0]?.subjectPageId).toBe("page:one");
  });

  it("reads missing runs as null and rejects malformed or wrong-tenant projections", async () => {
    let response = Response.json({ code: "workflow_run_not_found" }, { status: 404 });
    const remote = client(async () => response);
    expect(
      await remote.findRunByActionRequest({ organizationId, actionRequestId: "ar:one" }),
    ).toEqual(Result.succeed(null));
    response = Response.json(run({ organizationId: "organization:other" }));
    const wrongTenant = await remote.getRun({ organizationId, runId: "run:one" });
    expect(Result.isFailure(wrongTenant) && wrongTenant.error.code).toBe("platform_unavailable");
    response = Response.json({ id: "run:one" });
    const malformed = await remote.getRun({ organizationId, runId: "run:one" });
    expect(Result.isFailure(malformed) && malformed.error.code).toBe("platform_unavailable");
    response = Response.json(run({ id: "run:unexpected" }));
    const wrongRun = await remote.getRun({ organizationId, runId: "run:one" });
    expect(Result.isFailure(wrongRun) && wrongRun.error.code).toBe("platform_unavailable");
  });

  it("chunks the public API's 100-value correlation filter and returns newest runs", async () => {
    const seen: URL[] = [];
    const remote = client(async (request) => {
      const url = new URL(request.url);
      seen.push(url);
      const value = url.searchParams.getAll("correlationValue")[0];
      return Response.json({
        items: [
          run({
            id: `run:${value}`,
            correlation: { spaceId: value },
            startedAt: value === "space:100" ? "2026-09-30T02:00:00Z" : "2026-09-30T01:00:00Z",
          }),
        ],
      });
    });
    const spaceIds = Array.from({ length: 101 }, (_, index) => `space:${index}`);
    const listed = await remote.listRuns({ organizationId, spaceIds, limit: 2 });
    expect(Result.isSuccess(listed)).toBe(true);
    if (Result.isFailure(listed)) return;
    expect(listed.value.map((entry) => entry.id)).toEqual(["run:space:100", "run:space:0"]);
    expect(seen.map((url) => url.searchParams.getAll("correlationValue").length)).toEqual([100, 1]);
  });

  it("ignores non-Knowledge runs in a space's public history", async () => {
    const remote = client(async () =>
      Response.json({ items: [run({ actionType: "approval_policy_binding.update" }), run()] }),
    );
    const listed = await remote.listRuns({ organizationId, spaceIds: ["space:one"], limit: 10 });
    expect(Result.isSuccess(listed) && listed.value.map((entry) => entry.id)).toEqual(["run:one"]);
  });

  it("uses the bound user to answer Human Input, then reads the run", async () => {
    const seen: Request[] = [];
    const remote = client(async (request) => {
      seen.push(request);
      return request.method === "POST"
        ? Response.json({ runId: "run:one", inputKey: "effect:mine", status: "answered" })
        : Response.json(run({ status: "running" }));
    });
    const answered = await remote.submitHumanInput({
      organizationId,
      runId: "run:one",
      inputKey: "effect:mine",
      answer: "keep",
      actor: { id: "user:alice", displayName: "Alice" },
    });
    expect(Result.isSuccess(answered)).toBe(true);
    expect(seen[0]?.headers.get("idempotency-key")).toBe("effect:mine");
    expect(await seen[0]?.json()).toEqual({ answer: "keep" });
    expect(seen[1]?.method).toBe("GET");
  });

  it("refuses foreign actors and tenants before sending a request", async () => {
    const seen: Request[] = [];
    const remote = client(async (request) => {
      seen.push(request);
      return Response.json(run());
    });
    const foreignActor = await remote.startAction({
      ...action(),
      actor: { id: "user:bob", displayName: "Bob" },
    });
    expect(Result.isFailure(foreignActor) && foreignActor.error.code).toBe("forbidden");
    const foreignTenant = await remote.listRuns({
      organizationId: "organization:other",
      spaceIds: ["space:one"],
      limit: 10,
    });
    expect(Result.isFailure(foreignTenant) && foreignTenant.error.code).toBe("forbidden");
    const foreignAnswer = await remote.submitHumanInput({
      organizationId,
      runId: "run:one",
      inputKey: "effect:mine",
      answer: "keep",
      actor: { id: "user:bob", displayName: "Bob" },
    });
    expect(Result.isFailure(foreignAnswer) && foreignAnswer.error.code).toBe("forbidden");
    expect(seen).toHaveLength(0);
  });
});
