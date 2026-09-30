import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionWorkflowStarter } from "@app/approval-application";
import {
  brandLiteral,
  parseBrand,
  type ActionAuthorizer,
  type ActionRequest,
  type ActionRequestId,
  type ActionType,
  type JsonObject,
  type PrincipalRef,
  type ResourceId,
  type ResourceType,
} from "@app/approval-core";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import { staticCapabilityPolicy } from "@app/workflow-application";
import type { EffectId } from "@app/workflow-core";
import { createWorkflowPlatform } from "@app/workflow-platform";
import { QuickJsSandbox } from "@app/workflow-sandbox";
import { nodeQuickJsModule } from "@app/workflow-sandbox/node";

import { StagingSchemaResolver } from "../staging-schema-resolver.ts";
import { APPLICATION_CATALOGS } from "./knowledge.ts";
import { catalogCapabilityActions } from "./manifest.ts";
import { catalogActionExecutors } from "./runtime.ts";

const ORG = brandLiteral("OrganizationId", "organization:staging");
const EDITOR: PrincipalRef = { type: "user", id: brandLiteral("UserId", "user:editor") };
const OWNER = { type: "user" as const, id: brandLiteral("UserId", "user:owner") };
const TOKEN = "knowledge-mcp-token";

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  idempotencyKey: unknown;
  authorization: string | null;
};

/** Knowledge `/mcp`の代役（Service Binding先）。toolごとの応答を返し、呼び出しを記録する。 */
class FakeKnowledgeMcp {
  readonly calls: ToolCall[] = [];
  readonly failing = new Map<string, { code: string; retriable: boolean }>();

  private result(name: string, args: Record<string, unknown>): JsonObject {
    switch (name) {
      case "knowledge.publication.get":
        return {
          snapshot: {
            id: String(args["publicationSnapshotId"]),
            pageId: "page-1",
            visibility: "organization",
            sensitivity: "confidential",
          },
          revision: { id: "rev-1", number: 2, title: "Runbook", tags: [], body: "..." },
          page: { id: "page-1", ownerId: OWNER.id },
          space: { id: "space-1", key: "ENG", name: "Engineering" },
        };
      case "knowledge.pages.list_stale":
        return {
          pages: [
            { pageId: "page-stale", ownerId: OWNER.id },
            { pageId: "page-current", ownerId: OWNER.id },
          ],
        };
      case "knowledge.page.get_published":
        return {
          pageId: String(args["pageId"]),
          ownerId: OWNER.id,
          title: String(args["pageId"]),
          body: args["pageId"] === "page-stale" ? "TODO: update for 2022" : "Current.",
          publishedAt: "2026-09-01T00:00:00.000Z",
          lastReviewedAt: null,
        };
      default:
        return { ok: true, pageId: typeof args["pageId"] === "string" ? args["pageId"] : "" };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      id: string;
      params: { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> };
    };
    this.calls.push({
      name: body.params.name,
      arguments: body.params.arguments,
      idempotencyKey: body.params._meta["dev.ultra-easy/idempotencyKey"],
      authorization: request.headers.get("authorization"),
    });
    const failure = this.failing.get(body.params.name);
    const result = failure
      ? {
          resultType: "complete",
          content: [{ type: "text", text: failure.code }],
          structuredContent: {
            code: failure.code,
            message: failure.code,
            retriable: failure.retriable,
          },
          isError: true,
        }
      : {
          resultType: "complete",
          content: [{ type: "text", text: "ok" }],
          structuredContent: this.result(body.params.name, body.params.arguments),
        };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }
}

class AllowAuthorizer implements ActionAuthorizer {
  readonly denied = new Set<string>();

  async check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: "minimize_latency" | "higher_consistency";
  }) {
    if (this.denied.has(String(input.request.action.type))) {
      return Result.succeed({ type: "deny" as const, code: "permission_denied", reason: "denied" });
    }
    return Result.succeed({
      type: "allow" as const,
      evidence: {
        evaluatedAt: input.evaluatedAt,
        consistency: input.consistency,
        provider: "test",
      },
    });
  }
}

const noApprovals: ActionWorkflowStarter = {
  start: async (input) =>
    Result.succeed({ workflowInstanceId: `approval:${String(input.plan.actionRequestId)}` }),
};

function harness() {
  const db = migratedSqliteD1();
  const knowledge = new FakeKnowledgeMcp();
  const authorizer = new AllowAuthorizer();
  const platform = createWorkflowPlatform({
    db,
    organizationId: ORG,
    clock: { now: () => "2026-09-30T00:00:00.000Z" },
    authorizer,
    primitiveExecutors: catalogActionExecutors({
      DB: db,
      KNOWLEDGE: knowledge,
      KNOWLEDGE_MCP_TOKEN: TOKEN,
    } as unknown as Parameters<typeof catalogActionExecutors>[0]),
    workflowStarter: noApprovals,
    schemaResolver: new StagingSchemaResolver(),
    sandbox: new QuickJsSandbox(nodeQuickJsModule),
    pollIntervalSeconds: 5,
    governance: {
      capabilityPolicy: staticCapabilityPolicy({
        actions: catalogCapabilityActions(APPLICATION_CATALOGS),
        maxEffects: 16,
      }),
    },
  });

  async function submit(
    actionType: string,
    resource: { type: string; id: string },
    input: JsonObject,
    actor: PrincipalRef = EDITOR,
  ) {
    const type = parseBrand("ActionType", actionType);
    const resourceType = parseBrand("ResourceType", resource.type);
    const resourceId = parseBrand("ResourceId", resource.id);
    assert(
      Result.isSuccess(type) && Result.isSuccess(resourceType) && Result.isSuccess(resourceId),
    );
    return platform.service.submit({
      action: {
        type: type.value as ActionType,
        resource: { type: resourceType.value as ResourceType, id: resourceId.value as ResourceId },
        input,
      },
      trustedContext: {
        actor,
        authority: { principal: actor },
        origin: { type: "api" },
        organization: { id: ORG, settings: {} },
        now: "2026-09-30T00:00:00.000Z",
      },
    });
  }

  async function settle(rounds = 20) {
    for (let round = 0; round < rounds; round += 1) {
      const due = await platform.repositories.runs.listDue({
        now: "2999-01-01T00:00:00.000Z",
        limit: 100,
      });
      assert(Result.isSuccess(due));
      if (due.value.length === 0) return;
      for (const key of due.value) await platform.runtime.advance(key);
    }
  }

  async function run(actionRequestId: ActionRequestId) {
    const found = await platform.repositories.runs.findByParentAction({
      organizationId: ORG,
      actionRequestId,
    });
    assert(Result.isSuccess(found) && found.value);
    return found.value;
  }

  async function status(actionRequestId: ActionRequestId) {
    const loaded = await platform.statuses.status({ organizationId: ORG, actionRequestId });
    assert(Result.isSuccess(loaded));
    return loaded.value?.status ?? null;
  }

  return { platform, knowledge, authorizer, submit, settle, run, status };
}

describe("Knowledge Application Catalog end to end (#198)", () => {
  it("runs knowledge.publish_document as an ActionRequest whose children call Knowledge /mcp", async () => {
    const h = harness();
    const submitted = await h.submit(
      "knowledge.publish_document",
      { type: "knowledge_page", id: "page-1" },
      { pageId: "page-1", publicationSnapshotId: "snap-1" },
    );
    assert(Result.isSuccess(submitted) && submitted.value.type === "accepted");
    await h.settle();

    const run = await h.run(submitted.value.actionRequestId);
    expect(run.state.status).toBe("succeeded");
    expect(await h.status(submitted.value.actionRequestId)).toBe("executed");
    expect(h.knowledge.calls.map((call) => call.name).sort()).toEqual([
      "knowledge.publication.get",
      "knowledge.revision.publish",
      "knowledge.search.reindex",
      "knowledge.watchers.notify",
    ]);
    const publish = h.knowledge.calls.find((call) => call.name === "knowledge.revision.publish");
    // The page comes from the authorized resource; policy fields come from the snapshot.
    expect(publish?.arguments).toEqual({
      publicationSnapshotId: "snap-1",
      visibility: "organization",
      sensitivity: "confidential",
      pageId: "page-1",
    });
    expect(publish?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(typeof publish?.idempotencyKey).toBe("string");
  });

  it("fails the run when a Knowledge tool reports an error instead of treating it as success", async () => {
    const h = harness();
    h.knowledge.failing.set("knowledge.revision.publish", {
      code: "publication_conflict",
      retriable: false,
    });
    const submitted = await h.submit(
      "knowledge.publish_document",
      { type: "knowledge_page", id: "page-1" },
      { pageId: "page-1", publicationSnapshotId: "snap-1" },
    );
    assert(Result.isSuccess(submitted) && submitted.value.type === "accepted");
    await h.settle();
    const run = await h.run(submitted.value.actionRequestId);
    expect(run.state.status).toBe("failed");
    expect(h.knowledge.calls.map((call) => call.name)).not.toContain("knowledge.search.reindex");
  });

  it("asks the page owner through Human Input during knowledge.maintain_space and applies the answer", async () => {
    const h = harness();
    const submitted = await h.submit(
      "knowledge.maintain_space",
      { type: "knowledge_space", id: "space-1" },
      { spaceId: "space-1" },
      OWNER,
    );
    assert(Result.isSuccess(submitted) && submitted.value.type === "accepted");
    await h.settle();

    const waiting = await h.run(submitted.value.actionRequestId);
    expect(waiting.state.status).toBe("waiting");
    const inputs = Object.values(waiting.state.effects).filter(
      (effect) => effect.request.kind === "human_input" && effect.status === "in_flight",
    );
    expect(inputs).toHaveLength(1);
    const humanInput = inputs[0];
    assert(humanInput && humanInput.request.kind === "human_input");
    expect(humanInput.request).toMatchObject({
      assignee: OWNER,
      options: ["still_valid", "update_needed", "archive_candidate"],
      subject: { type: "knowledge_page", id: "page-stale" },
    });
    // The current page was reviewed without asking anyone.
    expect(
      h.knowledge.calls.filter((call) => call.name === "knowledge.page.mark_reviewed"),
    ).toEqual([
      expect.objectContaining({ arguments: { outcome: "reviewed", pageId: "page-current" } }),
    ]);

    const answered = await h.platform.runtime.answerHumanInput({
      organizationId: ORG,
      runId: waiting.state.runId,
      effectId: humanInput.id as EffectId,
      answer: "archive_candidate",
      actor: OWNER,
    });
    assert(Result.isSuccess(answered), Result.isFailure(answered) ? answered.error.message : "");
    await h.settle();

    const done = await h.run(submitted.value.actionRequestId);
    expect(done.state.status).toBe("succeeded");
    expect(
      h.knowledge.calls.find((call) => call.name === "knowledge.page.archive")?.arguments,
    ).toEqual({ pageOwnerId: OWNER.id, pageId: "page-stale" });
    expect(done.state.output).toMatchObject({
      spaceId: "space-1",
      pages: [
        { pageId: "page-stale", decision: "archive_candidate", resolution: "archived" },
        { pageId: "page-current", resolution: "reviewed" },
      ],
    });
  });

  it("executes a directly submitted primitive (e.g. a retried side effect) through the registered route", async () => {
    const h = harness();
    const submitted = await h.submit(
      "knowledge.search.reindex",
      { type: "knowledge_page", id: "page-1" },
      { publicationSnapshotId: "snap-1" },
    );
    assert(Result.isSuccess(submitted) && submitted.value.type === "accepted");
    expect(await h.status(submitted.value.actionRequestId)).toBe("executed");
    expect(h.knowledge.calls).toEqual([
      expect.objectContaining({
        name: "knowledge.search.reindex",
        arguments: { publicationSnapshotId: "snap-1", pageId: "page-1" },
      }),
    ]);
  });

  it("rejects input outside the registered schema before any side effect", async () => {
    const h = harness();
    const submitted = await h.submit(
      "knowledge.search.reindex",
      { type: "knowledge_page", id: "page-1" },
      { publicationSnapshotId: "snap-1", pageId: "page-of-another-space" },
    );
    expect(Result.isSuccess(submitted) && submitted.value.type === "accepted").toBe(false);
    expect(h.knowledge.calls).toEqual([]);
  });

  it("does not call Knowledge when the requester is not authorized", async () => {
    const h = harness();
    h.authorizer.denied.add("knowledge.page.archive");
    const submitted = await h.submit(
      "knowledge.page.archive",
      { type: "knowledge_page", id: "page-1" },
      { pageOwnerId: OWNER.id },
    );
    assert(Result.isSuccess(submitted));
    expect(submitted.value.type).toBe("authorization_denied");
    expect(h.knowledge.calls).toEqual([]);
  });
});
