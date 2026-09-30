import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { D1PublicApiRepository } from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import {
  HttpTrustedContextError,
  type ActionRequestView,
  type ApprovalReadRepository,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import type {
  ActionFingerprint,
  ActionRequestId,
  ClientId,
  OrganizationId,
  PrincipalRef,
  UserId,
  UserPrincipalRef,
} from "@app/approval-core";
import {
  HumanInputEffectHandler,
  WorkflowRuntime,
  type EffectOutcomeReport,
  type WorkflowInvocation,
} from "@app/workflow-application";
import { publishWorkflowVersion, type WorkflowRunId } from "@app/workflow-core";
import { TEST_CONTEXT, definition, edges, f, graph, id, n, obj } from "@app/workflow-core/testing";
import { D1WorkflowRunRepository, D1WorkflowVersionRepository } from "@app/workflow-d1";

import { createPublicHumanInputApi } from "./public-human-input-http.ts";
import type { WorkflowPlatform } from "./platform.ts";

const organizationId = "org:human-input" as OrganizationId;
const otherOrganizationId = "org:other" as OrganizationId;
const actionRequestId = "action-request:human-input" as ActionRequestId;
const secondActionRequestId = "action-request:human-input-2" as ActionRequestId;
const runId = id<WorkflowRunId>("run:human-input");
const secondRunId = id<WorkflowRunId>("run:human-input-2");
const alice: PrincipalRef = { type: "user", id: "user:alice" as UserId };
const bob: UserPrincipalRef = { type: "user", id: "user:bob" as UserId };
const charlie: PrincipalRef = { type: "user", id: "user:charlie" as UserId };
const clock = { now: () => "2026-09-30T00:00:00.000Z" };

function actionView(id: ActionRequestId = actionRequestId): ActionRequestView {
  return {
    id,
    organizationId,
    actor: alice,
    authorityPrincipal: alice,
    action: {
      type: "knowledge.maintenance" as ActionRequestView["action"]["type"],
      resource: {
        type: "knowledge_space" as ActionRequestView["action"]["resource"]["type"],
        id: "space:one" as ActionRequestView["action"]["resource"]["id"],
      },
      input: {},
    },
    origin: "api",
    status: "executing",
    approval: { required: false },
    checksums: {
      actionFingerprint: "fingerprint",
      evaluationSnapshotChecksum: "snapshot",
      approvalPlanChecksum: "approval",
    },
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
}

async function harness(secondRun = false, structuredAnswer = false) {
  const db = migratedSqliteD1();
  const versions = new D1WorkflowVersionRepository(db);
  const runs = new D1WorkflowRunRepository(db);
  const published = await publishWorkflowVersion({
    definition: definition(
      graph(
        [
          n.trigger(),
          {
            id: id("prog"),
            type: "program",
            program: {
              programId: id("program:review"),
              version: 1,
              sourceDigest: id("sha256:review"),
            },
            input: obj({}),
          } as never,
          n.output(f("nodes.prog.output")),
        ],
        edges("start->prog", "prog->end"),
      ),
    ),
    latestVersion: null,
    publishedAt: clock.now(),
    publishedBy: alice,
  });
  if (Result.isFailure(published)) expect.fail(published.error.message);
  const savedVersion = await versions.save({ organizationId, version: published.value });
  if (Result.isFailure(savedVersion)) expect.fail(savedVersion.error.message);
  const runtime = () =>
    new WorkflowRuntime({
      versions,
      runs,
      clock,
      effects: {
        human_input: new HumanInputEffectHandler(),
        program: {
          async dispatch(context) {
            const report: EffectOutcomeReport =
              context.effect.request.kind === "program" && context.effect.request.resume
                ? { type: "completed", output: { reviewed: true } }
                : {
                    type: "yielded",
                    state: {},
                    effect: structuredAnswer
                      ? {
                          type: "human_input",
                          prompt: "Review page",
                          assignee: bob,
                          answerSchema: {
                            type: "object",
                            properties: { choice: { type: "string", enum: ["keep", "archive"] } },
                            required: ["choice"],
                            additionalProperties: false,
                          },
                        }
                      : {
                          type: "human_input",
                          prompt: "Review page",
                          assignee: bob,
                          options: ["keep", "archive"],
                          answerSchema: { type: "string", enum: ["keep", "archive"] },
                          subject: { type: "knowledge_page", id: "page:one", title: "Page One" },
                          analysis: "Possibly stale",
                        },
                  };
            return Result.succeed(report);
          },
        },
      },
    });
  const invocation: WorkflowInvocation = {
    actor: alice,
    authority: { principal: alice },
    origin: { type: "api" },
    parentAction: {
      actionRequestId,
      actionFingerprint: "fingerprint" as ActionFingerprint,
      idempotencyKey: "start-key",
      executionRef: String(runId),
    },
  };
  const started = await runtime().start({
    organizationId,
    runId,
    definitionId: published.value.definitionId,
    version: published.value.version,
    checksum: String(published.value.checksum),
    input: {},
    context: TEST_CONTEXT,
    invocation,
    depth: 0,
  });
  if (Result.isFailure(started)) expect.fail(started.error.message);
  expect(started.value.status).toBe("waiting");
  if (secondRun) {
    const second = await runtime().start({
      organizationId,
      runId: secondRunId,
      definitionId: published.value.definitionId,
      version: published.value.version,
      checksum: String(published.value.checksum),
      input: {},
      context: TEST_CONTEXT,
      invocation: {
        ...invocation,
        parentAction: {
          ...invocation.parentAction!,
          actionRequestId: secondActionRequestId,
          executionRef: String(secondRunId),
        },
      },
      depth: 0,
    });
    if (Result.isFailure(second)) expect.fail(second.error.message);
    expect(second.value.status).toBe("waiting");
  }
  const loaded = await runs.load({ organizationId, runId });
  if (Result.isFailure(loaded) || !loaded.value) expect.fail("run not found");
  const effect = Object.values(loaded.value.state.effects).find(
    (item) => item.request.kind === "human_input",
  );
  if (!effect) expect.fail("human input not found");

  const readRepository = {
    getActionRequest: async ({
      organizationId: requested,
      actionRequestId: requestedAction,
    }: {
      organizationId: OrganizationId;
      actionRequestId: ActionRequestId;
    }) =>
      Result.succeed(
        requested === organizationId &&
          (requestedAction === actionRequestId || requestedAction === secondActionRequestId)
          ? actionView(requestedAction)
          : null,
      ),
  } as unknown as ApprovalReadRepository;
  const identityProvider: PublicHttpIdentityProvider = {
    authenticate: async ({ request, actionType, organizationId: requested }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (requested !== organizationId) return Result.succeed(bob);
      if (token === "scope-denied" && actionType)
        return Result.fail(
          new HttpTrustedContextError(403, "client_operation_not_allowed", "Forbidden"),
        );
      if (token === "alice") return Result.succeed(alice);
      if (token === "bob") return Result.succeed(bob);
      if (token === "charlie") return Result.succeed(charlie);
      if (token === "scope-denied") return Result.succeed(bob);
      if (token === "machine")
        return Result.succeed({ type: "service", id: "service:bot" } as PrincipalRef);
      return Result.fail(
        new HttpTrustedContextError(401, "authentication_required", "Authentication required"),
      );
    },
    authenticateWithClient: async ({ request }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      const principal = token === "bob" ? bob : token === "alice" ? alice : charlie;
      return Result.succeed({ principal, clientId: "client:knowledge" as ClientId });
    },
  };
  const wakes: string[] = [];
  const api = createPublicHumanInputApi({
    db,
    platform: { repositories: { runs, versions }, runtime: runtime() } as WorkflowPlatform,
    readRepository,
    identityProvider,
    idempotencyRepository: new D1PublicApiRepository(db),
    clock,
    onAnswerAccepted: async (key) => {
      wakes.push(String(key.runId));
    },
  });
  return { api, runs, runtime, effectId: String(effect.id), wakes };
}

function request(path: string, viewer: string, answer?: string, key = "answer-key") {
  return new Request(`https://api.example.test${path}`, {
    method: answer === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${viewer}`,
      ...(answer !== undefined
        ? { "content-type": "application/json", "idempotency-key": key }
        : {}),
    },
    ...(answer !== undefined ? { body: JSON.stringify({ answer }) } : {}),
  });
}

describe("public Human Input API", () => {
  it("lists only the assignee's waiting inputs and checks the parent action scope", async () => {
    const { api, effectId } = await harness();
    const path = `/v1/organizations/${organizationId}/me/human-inputs`;
    const bobResponse = await api.fetch(request(path, "bob"));
    expect(bobResponse.status).toBe(200);
    expect(await bobResponse.json()).toMatchObject({
      items: [
        {
          key: effectId,
          runId: String(runId),
          actionRequestId,
          assigneeId: String(bob.id),
          prompt: "Review page",
          options: ["keep", "archive"],
          subject: { type: "knowledge_page", id: "page:one", title: "Page One" },
          analysis: "Possibly stale",
        },
      ],
    });
    for (const viewer of ["alice", "charlie", "scope-denied"]) {
      const response = await api.fetch(request(path, viewer));
      expect(response.status).toBe(200);
      expect((await response.json()) as { items: unknown[] }).toMatchObject({ items: [] });
    }
    expect((await api.fetch(request(path, "machine"))).status).toBe(403);
    expect(
      (await api.fetch(request(`/v1/organizations/${otherOrganizationId}/me/human-inputs`, "bob")))
        .status,
    ).toBe(200);
    const other = await api.fetch(
      request(`/v1/organizations/${otherOrganizationId}/me/human-inputs`, "bob"),
    );
    expect((await other.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });

  it("paginates multiple assigned inputs without losing a short final batch", async () => {
    const { api } = await harness(true);
    const path = `/v1/organizations/${organizationId}/me/human-inputs?limit=1`;
    const first = await api.fetch(request(path, "bob"));
    const firstPage = (await first.json()) as {
      items: Array<{ runId: string }>;
      nextCursor?: string;
    };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const second = await api.fetch(
      request(`${path}&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`, "bob"),
    );
    const secondPage = (await second.json()) as {
      items: Array<{ runId: string }>;
      nextCursor?: string;
    };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(new Set([firstPage.items[0]?.runId, secondPage.items[0]?.runId])).toEqual(
      new Set([String(runId), String(secondRunId)]),
    );
  });

  it("accepts one valid answer, replays its key, rejects other answers, audits and resumes from D1", async () => {
    const { api, runs, runtime, effectId, wakes } = await harness();
    const path = `/v1/organizations/${organizationId}/workflow-runs/${runId}/human-inputs/${encodeURIComponent(effectId)}/answer`;
    expect((await api.fetch(request(path, "charlie", "keep"))).status).toBe(404);
    expect((await api.fetch(request(path, "alice", "keep"))).status).toBe(404);
    expect((await api.fetch(request(path, "scope-denied", "keep"))).status).toBe(403);
    expect((await api.fetch(request(path, "bob", "invalid", "invalid-key"))).status).toBe(400);
    const accepted = await api.fetch(request(path, "bob", "keep"));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "answered", inputKey: effectId });
    expect((await api.fetch(request(path, "bob", "keep"))).status).toBe(200);
    expect((await api.fetch(request(path, "bob", "archive"))).status).toBe(409);
    expect((await api.fetch(request(path, "bob", "archive", "other-key"))).status).toBe(409);
    expect(wakes).toEqual([String(runId)]);
    const otherPath = `/v1/organizations/${otherOrganizationId}/workflow-runs/${runId}/human-inputs/${encodeURIComponent(effectId)}/answer`;
    expect((await api.fetch(request(otherPath, "bob", "keep"))).status).toBe(404);

    const stored = await runs.load({ organizationId, runId });
    if (Result.isFailure(stored) || !stored.value) expect.fail("run not found");
    expect(stored.value.state.effects[effectId]).toMatchObject({
      status: "completed",
      answeredBy: bob,
      answeredViaClientId: "client:knowledge",
      answerIdempotencyKey: "answer-key",
    });
    expect(stored.value.wakeAt).toBe(clock.now());
    const events = await runs.listEvents({ organizationId, runId });
    expect(
      Result.isSuccess(events) &&
        events.value.some(
          (event) =>
            event.type === "human_input.answered" &&
            event.data["answeredBy"] === String(bob.id) &&
            event.data["clientId"] === "client:knowledge",
        ),
    ).toBe(true);
    const resumed = await runtime().advance({ organizationId, runId });
    expect(Result.isSuccess(resumed) && resumed.value.status).toBe("succeeded");
    const inbox = await api.fetch(
      request(`/v1/organizations/${organizationId}/me/human-inputs`, "bob"),
    );
    expect((await inbox.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });

  it("recovers a successful CAS when the HTTP idempotency response was not stored", async () => {
    const { api, runtime, effectId } = await harness();
    const direct = await runtime().answerHumanInput({
      organizationId,
      runId,
      effectId: id(effectId),
      answer: "keep",
      actor: bob,
      idempotencyKey: "answer-key",
    });
    expect(Result.isSuccess(direct)).toBe(true);
    const path = `/v1/organizations/${organizationId}/workflow-runs/${runId}/human-inputs/${encodeURIComponent(effectId)}/answer`;
    const replay = await api.fetch(request(path, "bob", "keep"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      runId: String(runId),
      inputKey: effectId,
      status: "answered",
    });
  });

  it("accepts only one of two concurrent answers with different keys", async () => {
    const { api, effectId } = await harness();
    const path = `/v1/organizations/${organizationId}/workflow-runs/${runId}/human-inputs/${encodeURIComponent(effectId)}/answer`;
    const responses = await Promise.all([
      api.fetch(request(path, "bob", "keep", "answer-a")),
      api.fetch(request(path, "bob", "archive", "answer-b")),
    ]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });

  it("validates structured JSON answers against the saved answer schema", async () => {
    const { api, runs, effectId } = await harness(false, true);
    const path = `/v1/organizations/${organizationId}/workflow-runs/${runId}/human-inputs/${encodeURIComponent(effectId)}/answer`;
    const post = (answer: unknown, key: string) =>
      api.fetch(
        new Request(`https://api.example.test${path}`, {
          method: "POST",
          headers: { authorization: "Bearer bob", "idempotency-key": key },
          body: JSON.stringify({ answer }),
        }),
      );
    expect((await post({ choice: "other" }, "invalid-choice")).status).toBe(400);
    expect((await post({ choice: "keep", extra: true }, "invalid-extra")).status).toBe(400);
    expect((await post({ choice: "keep" }, "structured-key")).status).toBe(200);
    const stored = await runs.load({ organizationId, runId });
    if (Result.isFailure(stored) || !stored.value) expect.fail("run not found");
    expect(stored.value.state.effects[effectId]?.outcome).toEqual({
      type: "completed",
      output: { choice: "keep" },
    });
  });
});
