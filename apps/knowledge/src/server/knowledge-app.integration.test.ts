import { Result } from "@praha/byethrow";
import { assert, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratedKnowledgeD1,
  sqliteD1WithMigrations,
  type SqliteD1Database,
} from "@app/knowledge-d1/testing";

import type {
  AutomationDetailView,
  AutomationView,
  EditView,
  HomeView,
  PageView,
  SearchView,
  SpaceDetailView,
  SpaceSettingsView,
} from "../shared/api.ts";
import { handleKnowledgeApi } from "./api.ts";
import { createRuntime, type KnowledgeRuntime } from "./runtime.ts";

const MOCK_MIGRATIONS = new URL("../../ultra-easy-mock/migrations/", import.meta.url);

let knowledgeDb: SqliteD1Database;
let platformDb: SqliteD1Database;
let runtime: KnowledgeRuntime;
let clock: number;

beforeEach(() => {
  knowledgeDb = migratedKnowledgeD1();
  platformDb = sqliteD1WithMigrations(MOCK_MIGRATIONS);
  clock = Date.parse("2026-09-25T09:00:00.000Z");
  const created = createRuntime(
    { KNOWLEDGE_DB: knowledgeDb, ULTRA_EASY_MOCK_DB: platformDb },
    // strictly increasing clock keeps "latest" ordering deterministic
    { now: () => new Date((clock += 1000)).toISOString() },
  );
  assert(Result.isSuccess(created));
  runtime = created.value;
});

type Client = {
  get<T>(path: string): Promise<{ status: number; body: T }>;
  send<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
};

async function signIn(principalId: string): Promise<Client> {
  const response = await handleKnowledgeApi(
    new Request("https://knowledge.test/api/demo/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-knowledge-client": "1" },
      body: JSON.stringify({ principalId }),
    }),
    runtime,
  );
  expect(response.status).toBe(204);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const result = await handleKnowledgeApi(
      new Request(`https://knowledge.test${path}`, {
        method,
        headers: {
          cookie,
          "x-knowledge-client": "1",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      runtime,
    );
    const text = await result.text();
    return { status: result.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return { get: (path) => call("GET", path), send: call };
}

function count(db: SqliteD1Database, sql: string): number {
  return Number((db.db.prepare(sql).get() as { total: number }).total);
}

const CF = "/api/spaces/engineering/pages/pg_cf_workers_deploy";

async function saveDraft(client: Client, path: string, changes: Record<string, unknown>) {
  const edit = await client.get<EditView>(`${path}/edit`);
  expect(edit.status).toBe(200);
  const saved = await client.send<EditView["draft"]>("PUT", `${path}/draft`, {
    ...edit.body.draft,
    ...changes,
    expectedVersion: edit.body.draft.version,
  });
  expect(saved.status).toBe(200);
  return saved.body;
}

async function publish(client: Client, path: string) {
  const view = await client.get<PageView>(path);
  assert(view.body.nextPublication);
  return client.send<{ snapshotId: string; revisionNumber: number; runStatus: string }>(
    "POST",
    `${path}/publish`,
    { expectedDraftVersion: view.body.nextPublication.draftVersion },
  );
}

async function approvalTaskId(client: Client, path: string): Promise<string> {
  const view = await client.get<PageView>(path);
  const url = view.body.publication?.approvalUrl;
  assert(url, "approval url");
  return url.split("/").at(-1) ?? "";
}

async function decide(client: Client, taskId: string, decision: "approve" | "reject") {
  return client.send<{ ok: boolean }>("POST", `/api/mock-ultra-easy/approvals/${taskId}/decision`, {
    decision,
  });
}

describe("Knowledge Workspace demo scenario (#167 Definition of Done)", () => {
  it("draft saves never create ActionRequests", async () => {
    const yuki = await signIn("user:yuki");
    await saveDraft(yuki, CF, { body: "# Deploying\n\nfirst edit" });
    await saveDraft(yuki, CF, { body: "# Deploying\n\nsecond edit" });
    expect(count(platformDb, "SELECT count(*) AS total FROM mock_action_requests")).toBe(0);
    const page = await yuki.get<PageView>(CF);
    expect(page.body.draft?.hasUnpublishedChanges).toBe(true);
    expect(page.body.published?.body).toContain("standard deployment path");
  });

  it("publishes the exact snapshot after child approval, with re-authorization", async () => {
    const yuki = await signIn("user:yuki");
    const morgan = await signIn("user:morgan");
    await saveDraft(yuki, CF, { body: "# Deploying\n\nR4 content", sensitivity: "confidential" });
    const started = await publish(yuki, CF);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ revisionNumber: 4, runStatus: "waiting_approval" });

    // edits while waiting do not change the pinned snapshot
    await saveDraft(yuki, CF, { body: "# Deploying\n\nlater edit", visibility: "private" });

    const waiting = await yuki.get<PageView>(CF);
    expect(waiting.body.publication).toMatchObject({
      state: "waiting_approval",
      revisionNumber: 4,
      visibility: "organization",
      sensitivity: "confidential",
    });
    expect(waiting.body.publication?.steps.map((step) => [step.key, step.status])).toEqual([
      ["analyze_metadata", "done"],
      ["related_pages", "done"],
      ["publication_approval", "waiting"],
      ["publish", "pending"],
      ["reindex", "pending"],
      ["notify", "pending"],
    ]);

    const taskId = await approvalTaskId(yuki, CF);
    // self-approval is not possible; Morgan (other space owner) approves
    expect((await decide(yuki, taskId, "approve")).status).toBe(403);
    expect((await decide(morgan, taskId, "approve")).status).toBe(200);

    const done = await yuki.get<PageView>(CF);
    expect(done.body.publication?.state).toBe("published");
    expect(done.body.published).toMatchObject({
      revisionNumber: 4,
      body: "# Deploying\n\nR4 content",
      visibility: "organization",
      sensitivity: "confidential",
    });
    // Sam watches the page and got exactly one notification
    const sam = await signIn("user:sam");
    const me = await sam.get<{ notifications: Array<{ revisionNumber: number }> }>("/api/me");
    expect(me.body.notifications.map((notification) => notification.revisionNumber)).toEqual([4]);
    const types = platformDb.db
      .prepare("SELECT type FROM mock_audit_events ORDER BY seq")
      .all()
      .map((row) => (row as { type: string }).type);
    expect(types).toContain("reauthorization.allowed");
    expect(types.indexOf("approval.approved")).toBeLessThan(
      types.indexOf("reauthorization.allowed"),
    );
  });

  it("newer publication wins over an old pending one (CAS conflict, no rollback)", async () => {
    const yuki = await signIn("user:yuki");
    const morgan = await signIn("user:morgan");
    await saveDraft(yuki, CF, { body: "R42 old" });
    const old = await publish(yuki, CF);
    expect(old.body.runStatus).toBe("waiting_approval");
    const oldTask = await approvalTaskId(yuki, CF);

    // space / normal publication needs no approval and commits immediately
    await saveDraft(yuki, CF, { body: "R43 new", visibility: "space", sensitivity: "normal" });
    const newer = await publish(yuki, CF);
    expect(newer.body.runStatus).toBe("succeeded");

    expect((await decide(morgan, oldTask, "approve")).status).toBe(200);
    const view = await yuki.get<PageView>(CF);
    expect(view.body.published?.body).toBe("R43 new");
    expect(view.body.publication).toMatchObject({
      state: "conflict",
      snapshotId: old.body.snapshotId,
      conflict: { reason: "lifecycle_mismatch" },
    });
    const home = await yuki.get<HomeView>("/api/home");
    expect(home.body.attention.some((item) => item.kind === "publication_conflict")).toBe(true);
  });

  it("archive wins over a pending publication; restore brings the page back", async () => {
    const yuki = await signIn("user:yuki");
    const morgan = await signIn("user:morgan");
    await saveDraft(yuki, CF, { body: "pending before archive" });
    await publish(yuki, CF);
    const task = await approvalTaskId(yuki, CF);
    const archived = await yuki.send<{ status: string }>("POST", `${CF}/archive`);
    expect(archived.body.status).toBe("succeeded");
    expect((await decide(morgan, task, "approve")).status).toBe(200);
    const view = await yuki.get<PageView>(CF);
    expect(view.body.page.status).toBe("archived");
    expect(view.body.publication).toMatchObject({
      state: "conflict",
      conflict: { reason: "archived" },
    });
    expect(view.body.access).toMatchObject({ edit: false, publish: false, restore: true });

    const sam = await signIn("user:sam");
    const search = await sam.get<SearchView>("/api/search?q=deploying");
    expect(search.body.results.some((result) => result.pageId === "pg_cf_workers_deploy")).toBe(
      false,
    );

    expect((await yuki.send("POST", `${CF}/restore`)).status).toBe(200);
    const restored = await sam.get<SearchView>("/api/search?q=deploying");
    expect(restored.body.results.some((result) => result.pageId === "pg_cf_workers_deploy")).toBe(
      true,
    );
  });

  it("post-publish notification failure keeps the page published and is recovered alone", async () => {
    const yuki = await signIn("user:yuki");
    expect((await yuki.send("POST", "/api/demo/faults", { notifier: true })).status).toBe(200);
    await saveDraft(yuki, CF, {
      body: "published despite notifier outage",
      visibility: "space",
      sensitivity: "normal",
    });
    const started = await publish(yuki, CF);
    expect(started.body.runStatus).toBe("failed");

    const failed = await yuki.get<PageView>(CF);
    expect(failed.body.published?.body).toBe("published despite notifier outage");
    expect(failed.body.publication).toMatchObject({
      state: "published_effect_failed",
      runStatus: "failed",
      retryableEffects: ["watcher_notification"],
      failure: { code: "notifier_unavailable" },
    });
    const publishRuns = () =>
      count(
        platformDb,
        "SELECT count(*) AS total FROM mock_action_requests WHERE action_type = 'knowledge.revision.publish'",
      );
    expect(publishRuns()).toBe(1);

    await yuki.send("POST", "/api/demo/faults", { notifier: false });
    const retried = await yuki.send<{ status: string }>(
      "POST",
      `/api/publications/${started.body.snapshotId}/effects/watcher_notification/retry`,
    );
    expect(retried.body.status).toBe("succeeded");
    expect(publishRuns()).toBe(1); // the publication itself is not re-executed

    const recovered = await yuki.get<PageView>(CF);
    expect(recovered.body.publication).toMatchObject({ state: "published", runStatus: "failed" });
    const notify = recovered.body.publication?.steps.find((step) => step.key === "notify");
    expect(notify).toMatchObject({ status: "done", detail: "Recovered by retry" });

    const automation = await yuki.get<AutomationView>("/api/automation");
    const original = automation.body.items.find((item) => item.kind === "publish_document");
    expect(original).toMatchObject({ statusLabel: "Recovered", category: "completed" });
    expect(automation.body.items.some((item) => item.kind === "recovery")).toBe(true);
  });

  it("viewers never see drafts through any projection", async () => {
    const alex = await signIn("user:alex");
    // a draft-only secret term on a published page and on a never-published page
    await saveDraft(alex, "/api/spaces/engineering/pages/pg_service_ownership", {
      title: "Service ownership zebracorn",
      body: "zebracorn plan",
    });
    const sam = await signIn("user:sam");
    const search = await sam.get<SearchView>("/api/search?q=zebracorn");
    expect(search.body.results).toEqual([]);
    const caching = await sam.get<SearchView>("/api/search?q=caching");
    expect(caching.body.results).toEqual([]);
    expect((await sam.get("/api/spaces/engineering/pages/pg_edge_caching")).status).toBe(404);
    const page = await sam.get<PageView>("/api/spaces/engineering/pages/pg_service_ownership");
    expect(page.body.published?.title).toBe("Service ownership model");
    expect(page.body.draft).toBeNull();
    expect(page.body.publication).toBeNull();
    expect(page.body.historyCount).toBeNull();
    expect(
      (await sam.get("/api/spaces/engineering/pages/pg_service_ownership/revisions")).status,
    ).toBe(404);
    const home = await sam.get<HomeView>("/api/home");
    expect(home.body.recentlyEdited).toEqual([]);
    expect(JSON.stringify(home.body)).not.toContain("zebracorn");
    const space = await sam.get<SpaceDetailView>("/api/spaces/engineering");
    expect(space.body.pages.every((row) => row.badge === "published")).toBe(true);
    expect(space.body.pages.some((row) => row.pageId === "pg_edge_caching")).toBe(false);

    const editor = await alex.get<SearchView>("/api/search?q=zebracorn");
    expect(editor.body.results.map((result) => result.badge)).toEqual(["draft_changes"]);
  });

  it("organization members without a role only see organization-wide pages", async () => {
    const riley = await signIn("user:riley");
    expect((await riley.get("/api/spaces/engineering")).status).toBe(404);
    const search = await riley.get<SearchView>("/api/search?q=deploy");
    expect(search.body.results.map((result) => result.pageId).sort()).toEqual(
      // HR's organization-wide page mentions "deployment timelines" too
      [
        "pg_benefits_enrollment",
        "pg_cf_workers_deploy",
        "pg_onboarding_checklist",
        "pg_workers_architecture",
      ],
    );
    const page = await riley.get<PageView>("/api/spaces/engineering/pages/pg_cf_workers_deploy");
    // backlinks only from sources Riley can read (CI/CD standards is space-only)
    expect(page.body.backlinks.map((entry) => entry.pageId).sort()).toEqual([
      "pg_onboarding_checklist",
      "pg_workers_architecture",
    ]);
    expect((await riley.get("/api/spaces/hr/pages/pg_compensation_bands")).status).toBe(404);
  });

  it("maintenance workflow: ForEach, LLM branch, durable human input and archive approval", async () => {
    const yuki = await signIn("user:yuki");
    const started = await yuki.send<{ runId: string; status: string }>(
      "POST",
      "/api/spaces/engineering/maintenance",
    );
    expect(started.body.status).toBe("waiting_input");
    const detail = await yuki.get<AutomationDetailView>(`/api/automation/${started.body.runId}`);
    expect(detail.body.humanInputs.map((input) => [input.pageId, input.canRespond])).toEqual([
      ["pg_api_auth_guide", true],
    ]);
    expect(detail.body.approvals).toHaveLength(1); // archive of Legacy deploy scripts

    // Morgan (not the assignee) cannot answer; nothing is kept in memory between requests
    const morgan = await signIn("user:morgan");
    expect(
      (
        await morgan.send(
          "POST",
          `/api/automation/${started.body.runId}/inputs/review:pg_api_auth_guide`,
          { answer: "still_valid" },
        )
      ).status,
    ).toBe(403);
    const answered = await yuki.send<{ status: string }>(
      "POST",
      `/api/automation/${started.body.runId}/inputs/review:pg_api_auth_guide`,
      { answer: "update_needed" },
    );
    expect(answered.body.status).toBe("waiting_approval");
    const home = await yuki.get<HomeView>("/api/home");
    expect(
      home.body.attention.some(
        (item) => item.kind === "update_needed" && item.pageId === "pg_api_auth_guide",
      ),
    ).toBe(true);

    // LLM "archive candidate" still needs the page owner's approval
    const taskId = detail.body.approvals[0]?.taskId ?? "";
    expect((await decide(yuki, taskId, "approve")).status).toBe(200);
    const legacy = await yuki.get<PageView>(
      "/api/spaces/engineering/pages/pg_legacy_deploy_scripts",
    );
    expect(legacy.body.page.status).toBe("archived");
    const finished = await yuki.get<AutomationDetailView>(`/api/automation/${started.body.runId}`);
    expect(finished.body.status).toBe("succeeded");
    const runbook = await yuki.get<PageView>("/api/spaces/engineering/pages/pg_incident_runbook");
    expect(runbook.body.page.reviewState).toBe("current");

    // run IDs do not leak across spaces
    const hana = await signIn("user:hana");
    expect((await hana.get(`/api/automation/${started.body.runId}`)).status).toBe(404);
  });

  it("space settings compile presets and go through governed meta-approval", async () => {
    const yuki = await signIn("user:yuki");
    const morgan = await signIn("user:morgan");
    const before = await yuki.get<SpaceSettingsView>("/api/spaces/engineering/settings");
    expect(before.body.rules.map((rule) => [rule.key, rule.requireApproval])).toEqual([
      ["publish_confidential", true],
      ["publish_organization", true],
      ["archive", true],
    ]);
    const proposed = await yuki.send<SpaceSettingsView>(
      "PUT",
      "/api/spaces/engineering/settings/approval-rules",
      {
        rules: [
          { key: "publish_confidential", requireApproval: true, approver: "space_owners" },
          { key: "publish_organization", requireApproval: false, approver: "space_owners" },
          { key: "archive", requireApproval: true, approver: "page_owner" },
        ],
      },
    );
    expect(proposed.body.pendingChange).not.toBeNull();
    expect(
      proposed.body.rules.find((rule) => rule.key === "publish_organization")?.requireApproval,
    ).toBe(true);
    const task = proposed.body.pendingChange?.approvalUrl.split("/").at(-1) ?? "";
    expect((await decide(morgan, task, "approve")).status).toBe(200);
    const after = await yuki.get<SpaceSettingsView>("/api/spaces/engineering/settings");
    expect(after.body.pendingChange).toBeNull();
    expect(
      after.body.rules.find((rule) => rule.key === "publish_organization")?.requireApproval,
    ).toBe(false);

    // organization-wide publication no longer needs approval
    await saveDraft(yuki, CF, { body: "org without approval" });
    expect((await publish(yuki, CF)).body.runStatus).toBe("succeeded");

    const sam = await signIn("user:sam");
    expect((await sam.get("/api/spaces/engineering/settings")).status).toBe(404);
  });

  it("rejects unauthenticated and cross-site requests", async () => {
    const anonymous = await handleKnowledgeApi(
      new Request("https://knowledge.test/api/home"),
      runtime,
    );
    expect(anonymous.status).toBe(401);
    const yuki = await signIn("user:yuki");
    void yuki;
    const csrf = await handleKnowledgeApi(
      new Request("https://knowledge.test/api/spaces", { method: "POST", body: "{}" }),
      runtime,
    );
    expect(csrf.status).toBe(403);
  });
});

describe("Knowledge MCP endpoint", () => {
  const mcp = (
    body: unknown,
    token = "knowledge-demo-mcp-token-not-for-production",
    version = "2026-07-28",
  ) =>
    runtime.mcp(
      new Request("https://knowledge.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-protocol-version": version,
        },
        body: JSON.stringify(body),
      }),
    );

  it("requires the service credential and the pinned protocol revision", async () => {
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
    expect(
      (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined, "2025-06-18")).status,
    ).toBe(400);
    const list = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: { tools: Array<{ name: string; _meta: Record<string, string> }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toContain("knowledge.revision.publish");
    expect(
      list.result.tools.find((tool) => tool.name === "knowledge.watchers.notify")?._meta[
        "dev.ultra-easy/guaranteeLevel"
      ],
    ).toBe("idempotent");
  });

  it("dedupes replays by idempotency key and rejects key reuse", async () => {
    const yuki = await signIn("user:yuki"); // triggers the demo seed
    void yuki;
    const call = (args: Record<string, unknown>, key: string) =>
      mcp({
        jsonrpc: "2.0",
        id: "c1",
        method: "tools/call",
        params: {
          name: "knowledge.page.mark_reviewed",
          arguments: args,
          _meta: { "dev.ultra-easy/idempotencyKey": key },
        },
      }).then(
        (response) =>
          response.json() as Promise<{ result?: { isError?: boolean }; error?: { code: number } }>,
      );
    const first = await call({ pageId: "pg_incident_runbook", outcome: "reviewed" }, "k1");
    expect(first.result?.isError).toBeUndefined();
    expect(count(knowledgeDb, "SELECT count(*) AS total FROM tool_invocations")).toBe(1);
    const replay = await call({ pageId: "pg_incident_runbook", outcome: "reviewed" }, "k1");
    expect(replay).toEqual(first);
    const reused = await call({ pageId: "pg_incident_runbook", outcome: "update_needed" }, "k1");
    expect(reused.error?.code).toBe(-32602);
  });
});
