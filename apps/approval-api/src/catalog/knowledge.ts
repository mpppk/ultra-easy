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
const PAGE_ID = { type: "string", maxLength: 64 } as const;

/**
 * Knowledgeのprimitive Actionはすべてspace単位で認可する（resource = `knowledge_space`、
 * role = owner / editor / viewer）。page / snapshotがそのspaceに属するかは、正本を持つ
 * Knowledgeが照合する（MCP routeはresourceのspace IDを`spaceId`として必ず渡す）。
 */
function primitive(
  actionType: string,
  relation: "can_view" | "can_edit" | "can_manage",
  input: CatalogPrimitiveAction["input"],
  version = 1,
): CatalogPrimitiveAction {
  return {
    actionType,
    version,
    resourceType: "knowledge_space",
    relation,
    tool: { server: KNOWLEDGE_SERVER, name: actionType, resourceIdArgument: "spaceId" },
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
  primitive("knowledge.publication.get", "can_edit", snapshotInput),
  // visibility / sensitivityはApproval Policyが参照する。Knowledge側がsnapshotの値と一致しない
  // requestを拒否するので、入力を偽ってpolicyを回避できない。
  primitive("knowledge.revision.publish", "can_edit", {
    type: "object",
    properties: {
      publicationSnapshotId: SNAPSHOT_ID,
      visibility: { type: "string", maxLength: 64 },
      sensitivity: { type: "string", maxLength: 64 },
    },
    required: ["publicationSnapshotId", "visibility", "sensitivity"],
    additionalProperties: false,
  }),
  // v2（#199）: 「page ownerが承認」ruleをpublishにも使えるよう、page ownerを必須inputにする
  // （Knowledgeが実際のownerと照合する）。v1は登録済みのまま残す（catalogはimmutable）。
  primitive(
    "knowledge.revision.publish",
    "can_edit",
    {
      type: "object",
      properties: {
        publicationSnapshotId: SNAPSHOT_ID,
        visibility: { type: "string", maxLength: 64 },
        sensitivity: { type: "string", maxLength: 64 },
        pageOwnerId: { type: "string", maxLength: 256 },
      },
      required: ["publicationSnapshotId", "visibility", "sensitivity", "pageOwnerId"],
      additionalProperties: false,
    },
    2,
  ),
  primitive("knowledge.search.reindex", "can_edit", snapshotInput),
  primitive("knowledge.watchers.notify", "can_edit", snapshotInput),
  primitive("knowledge.pages.list_stale", "can_view", {
    type: "object",
    properties: { staleAfterDays: { type: "integer", minimum: 1, maximum: 3650 } },
    additionalProperties: false,
  }),
  primitive("knowledge.page.get_published", "can_view", {
    type: "object",
    properties: { pageId: PAGE_ID },
    required: ["pageId"],
    additionalProperties: false,
  }),
  primitive("knowledge.page.mark_reviewed", "can_manage", {
    type: "object",
    properties: {
      pageId: PAGE_ID,
      outcome: { type: "string", enum: ["reviewed", "update_needed"] },
    },
    required: ["pageId", "outcome"],
    additionalProperties: false,
  }),
  // pageOwnerIdは「page owner以外のarchiveはownerの承認」policyが参照する（Knowledgeが実際の
  // ownerと照合する）。
  primitive("knowledge.page.archive", "can_manage", {
    type: "object",
    properties: { pageId: PAGE_ID, pageOwnerId: { type: "string", maxLength: 256 } },
    required: ["pageId", "pageOwnerId"],
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

function apply(spaceId, page, decision) {
  var state = { step: "apply", page: page, decision: decision };
  var resource = { type: "knowledge_space", id: spaceId };
  if (decision === "archive_candidate") {
    return ue.action(state, "knowledge.page.archive", resource, { pageId: page.pageId, pageOwnerId: page.ownerId });
  }
  var outcome = decision === "update_needed" ? "update_needed" : "reviewed";
  return ue.action(state, "knowledge.page.mark_reviewed", resource, { pageId: page.pageId, outcome: outcome });
}

function done(page, fields) {
  var output = { pageId: page.pageId, title: page.title || page.pageId, ownerId: page.ownerId || "", verdict: page.verdict || "", analysis: page.analysis || "" };
  for (var key in fields) output[key] = fields[key];
  return ue.complete(output);
}

function main(input, context) {
  var resume = context.resume;
  if (!resume) {
    return ue.action({ step: "read" }, "knowledge.page.get_published", { type: "knowledge_space", id: input.spaceId }, { pageId: input.pageId });
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
    return apply(input.spaceId, page, assessed.verdict === "archive_candidate" ? "archive_candidate" : "still_valid");
  }
  if (state.step === "review") {
    if (result.type !== "completed") return done(state.page, { decision: "", resolution: "failed", errorCode: result.code });
    return apply(input.spaceId, state.page, result.output);
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
  { actionType: "knowledge.page.get_published", resourceType: "knowledge_space" },
  { actionType: "knowledge.page.mark_reviewed", resourceType: "knowledge_space" },
  { actionType: "knowledge.page.archive", resourceType: "knowledge_space" },
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
      spaceId: { type: "string", maxLength: 64 },
      pageId: { type: "string", maxLength: 64 },
      ownerId: { type: "string", maxLength: 256 },
      now: { type: "string", maxLength: 64 },
    },
    required: ["spaceId", "pageId", "ownerId", "now"],
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

const space = { type: "knowledge_space", id: f("workflow.input.spaceId") };
const snapshot = { publicationSnapshotId: f("workflow.input.publicationSnapshotId") };

/**
 * publish: snapshotを読み、policyが参照するvisibility / sensitivityをsnapshot（trusted、Knowledge
 * 側で照合される）から子Actionへ渡す → 承認付きpublish → reindex / notify（独立した子Action）。
 */
const PUBLISH_DOCUMENT_ID = "wf:knowledge-publish-document";
/** v2（#199）はpage ownerもsnapshotから`knowledge.revision.publish` v2へ渡す。 */
const publishDocument = (version: 1 | 2): JsonObject => ({
  id: PUBLISH_DOCUMENT_ID,
  name: "Knowledge: publish document",
  description: "Publishes a pinned PublicationSnapshot with approval, then reindexes and notifies.",
  inputFields: [
    { path: "workflow.input.spaceId", type: "string", label: "Space" },
    { path: "workflow.input.publicationSnapshotId", type: "string", label: "Publication snapshot" },
  ],
  graph: {
    nodes: [
      { id: "start", type: "trigger" },
      action("get_publication", "knowledge.publication.get", space, snapshot, "Load publication"),
      action(
        "publish",
        "knowledge.revision.publish",
        space,
        {
          ...snapshot,
          visibility: f("nodes.get_publication.output.snapshot.visibility"),
          sensitivity: f("nodes.get_publication.output.snapshot.sensitivity"),
          ...(version === 2 ? { pageOwnerId: f("nodes.get_publication.output.page.ownerId") } : {}),
        },
        "Publish",
      ),
      action("reindex", "knowledge.search.reindex", space, snapshot, "Update search index"),
      action("notify", "knowledge.watchers.notify", space, snapshot, "Notify watchers"),
      { id: "effects", type: "join" },
      {
        id: "end",
        type: "output",
        value: obj({
          spaceId: f("workflow.input.spaceId"),
          pageId: f("nodes.get_publication.output.snapshot.pageId"),
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
});

/** maintain: stale pageを列挙し、pageごとにreview Programを実行する。 */
const MAINTAIN_SPACE_ID = "wf:knowledge-maintain-space";
const MAINTAIN_SPACE: JsonObject = {
  id: MAINTAIN_SPACE_ID,
  name: "Knowledge: maintain space",
  description: "Reviews stale published pages of a space with their owners.",
  inputFields: [{ path: "workflow.input.spaceId", type: "string", label: "Space" }],
  graph: {
    nodes: [
      { id: "start", type: "trigger" },
      action("list_stale", "knowledge.pages.list_stale", space, {}, "List stale pages"),
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
                spaceId: f("workflow.input.spaceId"),
                pageId: f("loop.item.pageId"),
                ownerId: f("loop.item.ownerId"),
                now: f("now"),
              }),
              capabilities: { actions: REVIEW_PAGE_ACTIONS, maxEffects: 3 },
            },
            { id: "page_result", type: "output", value: f("nodes.review_page.output") },
          ],
          edges: [edge("review_page", "page_result")],
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
};

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
      workflowId: PUBLISH_DOCUMENT_ID,
      workflowVersion: 1,
      resourceType: "knowledge_space",
      relation: "can_edit",
      workflow: publishDocument(1),
    },
    {
      actionType: "knowledge.publish_document",
      actionDefinitionVersion: 2,
      workflowId: PUBLISH_DOCUMENT_ID,
      workflowVersion: 2,
      resourceType: "knowledge_space",
      relation: "can_edit",
      workflow: publishDocument(2),
    },
    {
      actionType: "knowledge.maintain_space",
      actionDefinitionVersion: 1,
      workflowId: MAINTAIN_SPACE_ID,
      workflowVersion: 1,
      resourceType: "knowledge_space",
      relation: "can_manage",
      workflow: MAINTAIN_SPACE,
    },
  ],
  approvalPolicy: {
    scheme: {
      application: "knowledge",
      scopeResourceType: "knowledge_space",
      policyKey: "app:knowledge:approval",
      bindingId: "binding:app:knowledge:approval",
      metaPolicyKey: "app:knowledge:approval-policy-meta",
      metaBindingId: "binding:app:knowledge:approval-policy-meta",
      actions: [
        {
          actionType: "knowledge.revision.publish",
          conditionFields: ["visibility", "sensitivity"],
          principalFields: ["pageOwnerId"],
        },
        {
          actionType: "knowledge.page.archive",
          conditionFields: [],
          principalFields: ["pageOwnerId"],
        },
      ],
      approvers: {
        space_owners: { relation: "owner" },
        page_owner: { inputUser: "pageOwnerId" },
      },
      requesterIsNot: { page_owner: "pageOwnerId" },
      // 既定rule（apps/knowledgeの`DEFAULT_KNOWLEDGE_POLICY`と同じ）。
      defaultPolicy: {
        rules: [
          {
            key: "publish_confidential",
            actionType: "knowledge.revision.publish",
            when: { field: "sensitivity", equals: "confidential" },
            approvers: "space_owners",
          },
          {
            key: "publish_organization",
            actionType: "knowledge.revision.publish",
            when: { field: "visibility", equals: "organization" },
            approvers: "space_owners",
          },
          {
            key: "archive",
            actionType: "knowledge.page.archive",
            when: { requesterIsNot: "page_owner" },
            approvers: "page_owner",
          },
        ],
      },
      metaApprovalRelation: "owner",
    },
    updateRelation: "can_manage",
    metaPolicyVersion: 2,
  },
};

/** このdeploymentに登録されているApplication Catalog。 */
export const APPLICATION_CATALOGS: readonly ApplicationCatalog[] = [KNOWLEDGE_CATALOG];
