import type { JsonObject } from "@app/approval-core";

import type { ApplicationCatalog, CatalogPrimitiveAction, CatalogProgram } from "./manifest.ts";

/**
 * Knowledge Workspace（apps/knowledge, #167）のApplication Catalog（#198）。
 *
 * primitive `knowledge.*` ActionはKnowledgeの `/mcp`（Bearer `KNOWLEDGE_MCP_TOKEN`）のtoolで実行し、
 * `knowledge.publish_document` / `knowledge.maintain_space` はWorkflow-backed Composite Actionとして
 * それらを子ActionRequestで呼ぶ。登録済みversionは変更しない。変える場合はversionを上げて
 * `vp -C apps/approval-api run generate:catalog` で新しいcatalog migrationを作る。
 */

// Workflow DefinitionはJSONで書き、catalogが`parseWorkflowDefinition`で検証する。
const f = (path: string): JsonObject => ({ type: "field", path });
const obj = (fields: JsonObject): JsonObject => ({ type: "object", fields });
const edge = (source: string, target: string): JsonObject => ({
  id: `${source}->${target}`,
  source,
  target,
});

const KNOWLEDGE_SERVER = "knowledge";
const SNAPSHOT_ID = { type: "string", maxLength: 64 } as const;

function primitive(
  actionType: string,
  resourceType: "knowledge_page" | "knowledge_space",
  relation: string,
  input: CatalogPrimitiveAction["input"],
): CatalogPrimitiveAction {
  return {
    actionType,
    version: 1,
    resourceType,
    relation,
    tool: {
      server: KNOWLEDGE_SERVER,
      name: actionType,
      resourceIdArgument: resourceType === "knowledge_page" ? "pageId" : "spaceId",
    },
    input,
  };
}

const snapshotInput: CatalogPrimitiveAction["input"] = {
  type: "object",
  properties: { publicationSnapshotId: SNAPSHOT_ID },
  required: ["publicationSnapshotId"],
  additionalProperties: false,
};

const PRIMITIVES: CatalogPrimitiveAction[] = [
  primitive("knowledge.publication.get", "knowledge_page", "can_edit", snapshotInput),
  // visibility / sensitivityはApproval Policyが参照する。Knowledge側がsnapshotの値と一致しない
  // requestを拒否するので、入力を偽ってpolicyを回避できない。
  primitive("knowledge.revision.publish", "knowledge_page", "can_edit", {
    type: "object",
    properties: {
      publicationSnapshotId: SNAPSHOT_ID,
      visibility: { type: "string", maxLength: 64 },
      sensitivity: { type: "string", maxLength: 64 },
    },
    required: ["publicationSnapshotId", "visibility", "sensitivity"],
    additionalProperties: false,
  }),
  primitive("knowledge.search.reindex", "knowledge_page", "can_edit", snapshotInput),
  primitive("knowledge.watchers.notify", "knowledge_page", "can_edit", snapshotInput),
  primitive("knowledge.pages.list_stale", "knowledge_space", "can_view", {
    type: "object",
    properties: { staleAfterDays: { type: "integer", minimum: 1, maximum: 3650 } },
    additionalProperties: false,
  }),
  primitive("knowledge.page.get_published", "knowledge_page", "can_view", {
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  primitive("knowledge.page.mark_reviewed", "knowledge_page", "can_manage", {
    type: "object",
    properties: { outcome: { type: "string", enum: ["reviewed", "update_needed"] } },
    required: ["outcome"],
    additionalProperties: false,
  }),
  // pageOwnerIdは「page owner以外のarchiveはownerの承認」policyが参照する（Knowledgeが実際の
  // ownerと照合する）。
  primitive("knowledge.page.archive", "knowledge_page", "can_manage", {
    type: "object",
    properties: { pageOwnerId: { type: "string", maxLength: 256 } },
    required: ["pageOwnerId"],
    additionalProperties: false,
  }),
];

/**
 * 1ページのfreshness review（maintain_spaceのForEach body）。
 *
 * published revisionを読み、判定（#201でLLM Gatewayへ置き換えるまでの決定的なheuristic。
 * mock/llm.tsと同じ）→ 要確認ならpage ownerへHuman Input → mark_reviewed / archive
 * （archiveは通常のApproval Policyを通る）。判定は提案にすぎず承認を省略しない。
 */
const REVIEW_PAGE_SOURCE = `
var DAY_MS = 24 * 60 * 60 * 1000;
var OPTIONS = ["still_valid", "update_needed", "archive_candidate"];

function assess(page, now) {
  var body = typeof page.body === "string" ? page.body : "";
  if (/\\b(deprecated|obsolete|no longer (used|supported|maintained))\\b/i.test(body)) {
    return { verdict: "archive_candidate", analysis: "The page describes itself as deprecated / no longer used." };
  }
  var published = typeof page.publishedAt === "string" ? Date.parse(page.publishedAt) : 0;
  var reviewed = typeof page.lastReviewedAt === "string" ? Date.parse(page.lastReviewedAt) : 0;
  var reference = Math.max(published || 0, reviewed || 0);
  var ageDays = Math.floor((Date.parse(now) - reference) / DAY_MS);
  if (ageDays > 180 || /\\b(todo|tbd|20(1\\d|2[0-3]))\\b/i.test(body)) {
    return { verdict: "needs_review", analysis: "Last confirmed " + ageDays + " days ago and references possibly outdated details." };
  }
  return { verdict: "likely_current", analysis: "Last confirmed " + ageDays + " days ago; no outdated signals found." };
}

function apply(page, decision) {
  var state = { step: "apply", page: page, decision: decision };
  var resource = { type: "knowledge_page", id: page.pageId };
  if (decision === "archive_candidate") {
    return ue.action(state, "knowledge.page.archive", resource, { pageOwnerId: page.ownerId });
  }
  var outcome = decision === "update_needed" ? "update_needed" : "reviewed";
  return ue.action(state, "knowledge.page.mark_reviewed", resource, { outcome: outcome });
}

function done(page, fields) {
  var output = { pageId: page.pageId, title: page.title || page.pageId, ownerId: page.ownerId || "", verdict: page.verdict || "", analysis: page.analysis || "" };
  for (var key in fields) output[key] = fields[key];
  return ue.complete(output);
}

function main(input, context) {
  var resume = context.resume;
  if (!resume) {
    return ue.action({ step: "read" }, "knowledge.page.get_published", { type: "knowledge_page", id: input.pageId }, {});
  }
  var state = resume.state;
  var result = resume.effectResult;
  if (state.step === "read") {
    var fallback = { pageId: input.pageId, ownerId: input.ownerId };
    if (result.type !== "completed") return done(fallback, { decision: "", resolution: "failed", errorCode: result.code });
    var read = result.output;
    var assessed = assess(read, input.now);
    var page = { pageId: input.pageId, title: read.title || input.pageId, ownerId: read.ownerId, verdict: assessed.verdict, analysis: assessed.analysis };
    if (assessed.verdict === "needs_review") {
      return ue.askHuman({ step: "review", page: page }, {
        prompt: "This page may be stale. Is it still valid?",
        assignee: { type: "user", id: read.ownerId },
        options: OPTIONS,
        answerSchema: { type: "string", enum: OPTIONS },
        subject: { type: "knowledge_page", id: input.pageId, title: page.title },
        analysis: assessed.analysis
      });
    }
    return apply(page, assessed.verdict === "archive_candidate" ? "archive_candidate" : "still_valid");
  }
  if (state.step === "review") {
    if (result.type !== "completed") return done(state.page, { decision: "", resolution: "failed", errorCode: result.code });
    return apply(state.page, result.output);
  }
  if (result.type === "completed") {
    var resolution = state.decision === "archive_candidate" ? "archived" : state.decision === "update_needed" ? "update_needed" : "reviewed";
    return done(state.page, { decision: state.decision, resolution: resolution });
  }
  if (result.code === "rejected" || result.code === "cancelled" || result.code === "expired") {
    return done(state.page, { decision: state.decision, resolution: "archive_rejected" });
  }
  return done(state.page, { decision: state.decision, resolution: "failed", errorCode: result.code });
}
`.trim();

const REVIEW_PAGE_ACTIONS = [
  { actionType: "knowledge.page.get_published", resourceType: "knowledge_page" },
  { actionType: "knowledge.page.mark_reviewed", resourceType: "knowledge_page" },
  { actionType: "knowledge.page.archive", resourceType: "knowledge_page" },
];

const REVIEW_PAGE_PROGRAM: CatalogProgram = {
  programId: "prog:knowledge-review-page",
  version: 1,
  description:
    "Freshness review of one published Knowledge page (owner input, then review / archive).",
  source: REVIEW_PAGE_SOURCE,
  inputSchema: {
    type: "object",
    properties: {
      pageId: { type: "string", maxLength: 64 },
      ownerId: { type: "string", maxLength: 256 },
      now: { type: "string", maxLength: 64 },
    },
    required: ["pageId", "ownerId", "now"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      pageId: { type: "string" },
      title: { type: "string" },
      ownerId: { type: "string" },
      verdict: { type: "string" },
      analysis: { type: "string" },
      decision: { type: "string" },
      resolution: {
        type: "string",
        enum: ["reviewed", "update_needed", "archived", "archive_rejected", "failed"],
      },
      errorCode: { type: "string" },
    },
    required: ["pageId", "resolution"],
    additionalProperties: false,
  },
  // read → (human input) → apply。human inputは作用数に含めない。
  requestedCapabilities: { actions: REVIEW_PAGE_ACTIONS, maxEffects: 3 },
};

const action = (
  id: string,
  actionType: string,
  resource: JsonObject,
  input: JsonObject,
  label: string,
): JsonObject => ({ id, type: "action", label, actionType, resource, input: obj(input) });

const page = { type: "knowledge_page", id: f("workflow.input.pageId") };
const snapshot = { publicationSnapshotId: f("workflow.input.publicationSnapshotId") };

/**
 * publish: snapshotを読み、policyが参照するvisibility / sensitivityをsnapshot（trusted、Knowledge
 * 側で照合される）から子Actionへ渡す → 承認付きpublish → reindex / notify（独立した子Action）。
 */
const PUBLISH_DOCUMENT = {
  id: "wf:knowledge-publish-document",
  name: "Knowledge: publish document",
  description: "Publishes a pinned PublicationSnapshot with approval, then reindexes and notifies.",
  inputFields: [
    { path: "workflow.input.pageId", type: "string", label: "Page" },
    { path: "workflow.input.publicationSnapshotId", type: "string", label: "Publication snapshot" },
  ],
  graph: {
    nodes: [
      { id: "start", type: "trigger" },
      action("get_publication", "knowledge.publication.get", page, snapshot, "Load publication"),
      action(
        "publish",
        "knowledge.revision.publish",
        page,
        {
          ...snapshot,
          visibility: f("nodes.get_publication.output.snapshot.visibility"),
          sensitivity: f("nodes.get_publication.output.snapshot.sensitivity"),
        },
        "Publish",
      ),
      action("reindex", "knowledge.search.reindex", page, snapshot, "Update search index"),
      action("notify", "knowledge.watchers.notify", page, snapshot, "Notify watchers"),
      { id: "effects", type: "join" },
      {
        id: "end",
        type: "output",
        value: obj({
          pageId: f("workflow.input.pageId"),
          publicationSnapshotId: f("workflow.input.publicationSnapshotId"),
          publication: f("nodes.publish.output"),
        }),
      },
    ],
    edges: [
      edge("start", "get_publication"),
      edge("get_publication", "publish"),
      edge("publish", "reindex"),
      edge("publish", "notify"),
      edge("reindex", "effects"),
      edge("notify", "effects"),
      edge("effects", "end"),
    ],
  },
} satisfies JsonObject;

/** maintain: stale pageを列挙し、pageごとにreview Programを実行する。 */
const MAINTAIN_SPACE = {
  id: "wf:knowledge-maintain-space",
  name: "Knowledge: maintain space",
  description: "Reviews stale published pages of a space with their owners.",
  inputFields: [{ path: "workflow.input.spaceId", type: "string", label: "Space" }],
  graph: {
    nodes: [
      { id: "start", type: "trigger" },
      action(
        "list_stale",
        "knowledge.pages.list_stale",
        { type: "knowledge_space", id: f("workflow.input.spaceId") },
        {},
        "List stale pages",
      ),
      {
        id: "review",
        type: "for_each",
        label: "Review pages",
        collection: f("nodes.list_stale.output.pages"),
        concurrency: 4,
        maxItems: 50,
        body: {
          nodes: [
            {
              id: "review_page",
              type: "program",
              label: "Review page",
              program: {
                programId: REVIEW_PAGE_PROGRAM.programId,
                version: REVIEW_PAGE_PROGRAM.version,
                // renderCatalogEntriesがcatalogのsourceから埋める。
                sourceDigest: "sha256:catalog",
              },
              input: obj({
                pageId: f("loop.item.pageId"),
                ownerId: f("loop.item.ownerId"),
                now: f("now"),
              }),
              capabilities: { actions: REVIEW_PAGE_ACTIONS, maxEffects: 3 },
            },
          ],
          edges: [],
        },
      },
      {
        id: "end",
        type: "output",
        value: obj({ spaceId: f("workflow.input.spaceId"), pages: f("nodes.review.output") }),
      },
    ],
    edges: [edge("start", "list_stale"), edge("list_stale", "review"), edge("review", "end")],
  },
} satisfies JsonObject;

export const KNOWLEDGE_CATALOG: ApplicationCatalog = {
  application: "knowledge",
  actionTypePrefix: "knowledge.",
  organizations: ["organization:staging", "organization:production"],
  publishedAt: "2026-09-30T00:00:00.000Z",
  servers: [
    {
      id: KNOWLEDGE_SERVER,
      serviceBinding: "KNOWLEDGE",
      path: "/mcp",
      endpointVar: "KNOWLEDGE_MCP_URL",
      tokenSecret: "KNOWLEDGE_MCP_TOKEN",
      // mutating toolは`dev.ultra-easy/idempotencyKey`でdedupeし、それ以外はread-only。
      guaranteeLevel: "idempotent",
      timeoutMs: 15_000,
    },
  ],
  primitives: PRIMITIVES,
  programs: [REVIEW_PAGE_PROGRAM],
  composites: [
    {
      actionType: "knowledge.publish_document",
      actionDefinitionVersion: 1,
      workflowId: PUBLISH_DOCUMENT.id,
      workflowVersion: 1,
      resourceType: "knowledge_page",
      relation: "can_edit",
      workflow: PUBLISH_DOCUMENT,
    },
    {
      actionType: "knowledge.maintain_space",
      actionDefinitionVersion: 1,
      workflowId: MAINTAIN_SPACE.id,
      workflowVersion: 1,
      resourceType: "knowledge_space",
      relation: "can_manage",
      workflow: MAINTAIN_SPACE,
    },
  ],
};

/** このdeploymentに登録されているApplication Catalog。 */
export const APPLICATION_CATALOGS: readonly ApplicationCatalog[] = [KNOWLEDGE_CATALOG];
