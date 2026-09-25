import { Result } from "@praha/byethrow";
import { assert, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  ftsMatchExpression,
  readScope,
  type KnowledgeContext,
  type SpaceRole,
  type Visibility,
} from "@app/knowledge-core";

import { knowledgeRepositories, type KnowledgeRepositories } from "./index.ts";
import { migratedKnowledgeD1, type SqliteD1Database } from "./testing/index.ts";

function unwrap<T, E>(result: Result.Result<T, E>): T {
  if (Result.isFailure(result)) assert.fail(`unexpected failure: ${String(result.error)}`);
  return result.value;
}

const NOW = "2026-09-25T00:00:00.000Z";
const ORG = "org_acme";

function context(roles: Record<string, SpaceRole>, principalId: string): KnowledgeContext {
  return {
    organizationId: ORG,
    principal: { id: principalId, displayName: principalId },
    spaceRoles: new Map(Object.entries(roles)),
  };
}

let db: SqliteD1Database;
let repos: KnowledgeRepositories;

async function createPage(input: {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  visibility?: Visibility;
}) {
  unwrap(
    await repos.pages.create(
      {
        id: input.id,
        spaceId: "spc_eng",
        ownerId: "user:yuki",
        status: "active",
        lifecycleVersion: 0,
        publishedRevisionId: null,
        publishedSnapshotId: null,
        publishedVisibility: null,
        publishedSensitivity: null,
        publishedAt: null,
        publishedBy: null,
        reviewState: "current",
        lastReviewedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        pageId: input.id,
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        visibility: input.visibility ?? "space",
        sensitivity: "normal",
        version: 0,
        updatedBy: "user:yuki",
        updatedAt: NOW,
      },
    ),
  );
}

/** Revision + snapshot from the current draft (what the Publish action does). */
async function snapshotFromDraft(pageId: string, snapshotId: string, revisionNumber: number) {
  const draft = unwrap(await repos.pages.findDraft(pageId));
  const page = unwrap(await repos.pages.find(pageId));
  assert(draft && page);
  const revisionId = `rev_${snapshotId}`;
  return unwrap(
    await repos.revisions.insertPublication({
      revision: {
        id: revisionId,
        pageId,
        number: revisionNumber,
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        createdBy: "user:yuki",
        createdAt: NOW,
      },
      snapshot: {
        id: snapshotId,
        pageId,
        revisionId,
        revisionNumber,
        spaceId: page.spaceId,
        visibility: draft.visibility,
        sensitivity: draft.sensitivity,
        expectedLifecycleVersion: page.lifecycleVersion,
        createdBy: "user:yuki",
        createdAt: NOW,
      },
    }),
  );
}

async function saveDraft(
  pageId: string,
  changes: { title?: string; body?: string; visibility?: Visibility },
) {
  const draft = unwrap(await repos.pages.findDraft(pageId));
  assert(draft);
  return unwrap(
    await repos.pages.saveDraft({
      pageId,
      principalId: "user:yuki",
      now: NOW,
      draft: {
        title: changes.title ?? draft.title,
        body: changes.body ?? draft.body,
        tags: draft.tags,
        visibility: changes.visibility ?? draft.visibility,
        sensitivity: draft.sensitivity,
        expectedVersion: draft.version,
      },
    }),
  );
}

beforeEach(async () => {
  db = migratedKnowledgeD1();
  repos = knowledgeRepositories(db);
  for (const [id, key] of [
    ["spc_eng", "engineering"],
    ["spc_hr", "hr"],
  ] as const) {
    unwrap(
      await repos.spaces.create({
        id,
        organizationId: ORG,
        key,
        name: key,
        description: "",
        createdBy: "user:yuki",
        createdAt: NOW,
      }),
    );
  }
});

describe("spaces and drafts", () => {
  it("rejects duplicate space keys per organization", async () => {
    const duplicate = await repos.spaces.create({
      id: "spc_other",
      organizationId: ORG,
      key: "engineering",
      name: "dup",
      description: "",
      createdBy: "user:yuki",
      createdAt: NOW,
    });
    expect(Result.isFailure(duplicate) && duplicate.error.code).toBe("duplicate_key");
  });

  it("saves drafts with optimistic concurrency and never bumps the lifecycle", async () => {
    await createPage({ id: "pg_a", title: "Draft", body: "one" });
    const saved = await saveDraft("pg_a", { body: "two" });
    expect(saved.version).toBe(1);
    const stale = await repos.pages.saveDraft({
      pageId: "pg_a",
      principalId: "user:alex",
      now: NOW,
      draft: {
        title: "x",
        body: "y",
        tags: [],
        visibility: "space",
        sensitivity: "normal",
        expectedVersion: 0,
      },
    });
    expect(Result.isFailure(stale) && stale.error.code).toBe("draft_conflict");
    expect(unwrap(await repos.pages.find("pg_a"))?.lifecycleVersion).toBe(0);
  });

  it("keeps revisions and publication snapshots immutable", async () => {
    await createPage({ id: "pg_a", title: "Draft", body: "one" });
    await snapshotFromDraft("pg_a", "pub_1", 1);
    expect(() => db.db.exec("UPDATE revisions SET body = 'x'")).toThrow(/immutable/);
    expect(() => db.db.exec("DELETE FROM revisions")).toThrow(/append-only/);
    expect(() => db.db.exec("UPDATE publication_snapshots SET visibility = 'private'")).toThrow(
      /immutable/,
    );
  });
});

describe("publication commit (lifecycle CAS)", () => {
  it("publishes the exact snapshot and replays idempotently", async () => {
    await createPage({ id: "pg_a", title: "Deploy", body: "v1", visibility: "organization" });
    await snapshotFromDraft("pg_a", "pub_1", 1);
    // editing the draft after the snapshot does not change what gets published
    await saveDraft("pg_a", { body: "v2 draft", visibility: "private" });

    const first = unwrap(await repos.publications.commitPublish({ snapshotId: "pub_1", now: NOW }));
    expect(first?.outcome.status).toBe("published");
    const page = unwrap(await repos.pages.find("pg_a"));
    expect(page).toMatchObject({
      publishedSnapshotId: "pub_1",
      publishedRevisionId: "rev_pub_1",
      publishedVisibility: "organization",
      lifecycleVersion: 1,
    });
    const replay = unwrap(
      await repos.publications.commitPublish({ snapshotId: "pub_1", now: NOW }),
    );
    expect(replay?.outcome.status).toBe("published");
    expect(unwrap(await repos.pages.find("pg_a"))?.lifecycleVersion).toBe(1);
    expect(unwrap(await repos.effects.list("pub_1")).map((effect) => effect.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("newer publication wins: the old pending snapshot conflicts and never rolls back", async () => {
    await createPage({ id: "pg_a", title: "Deploy", body: "R42" });
    await snapshotFromDraft("pg_a", "pub_100", 1);
    await saveDraft("pg_a", { body: "R43" });
    await snapshotFromDraft("pg_a", "pub_101", 2);

    expect(
      unwrap(await repos.publications.commitPublish({ snapshotId: "pub_101", now: NOW }))?.outcome
        .status,
    ).toBe("published");
    const old = unwrap(await repos.publications.commitPublish({ snapshotId: "pub_100", now: NOW }));
    expect(old?.outcome).toMatchObject({
      status: "conflict",
      reason: "lifecycle_mismatch",
      expectedLifecycleVersion: 0,
      actualLifecycleVersion: 1,
    });
    expect(unwrap(await repos.pages.find("pg_a"))?.publishedRevisionId).toBe("rev_pub_101");
    expect(unwrap(await repos.effects.list("pub_100"))).toEqual([]);
  });

  it("archive wins over a pending publication", async () => {
    await createPage({ id: "pg_a", title: "Deploy", body: "v1" });
    await snapshotFromDraft("pg_a", "pub_100", 1);
    unwrap(await repos.pages.archive("pg_a", NOW));
    const result = unwrap(
      await repos.publications.commitPublish({ snapshotId: "pub_100", now: NOW }),
    );
    expect(result?.outcome).toMatchObject({ status: "conflict", reason: "archived" });
    expect(unwrap(await repos.pages.find("pg_a"))).toMatchObject({
      status: "archived",
      publishedRevisionId: null,
    });
  });
});

describe("authorization-aware projections", () => {
  async function publish(pageId: string, snapshotId: string, number: number) {
    await snapshotFromDraft(pageId, snapshotId, number);
    unwrap(await repos.publications.commitPublish({ snapshotId, now: NOW }));
    unwrap(await repos.search.reindexPublished(pageId));
  }

  beforeEach(async () => {
    await createPage({
      id: "pg_pub",
      title: "Workers deploy guide",
      body: "deploy workers safely",
      tags: ["infra"],
    });
    await publish("pg_pub", "pub_1", 1);
    // published, then a secret draft change
    await saveDraft("pg_pub", {
      title: "Workers deploy guide (secret rename)",
      body: "deploy secretplan",
    });
    // never published draft that links to the published page
    await createPage({
      id: "pg_draft",
      title: "Deploy secretplan draft",
      body: "deploy secretplan see [guide](/spaces/engineering/pages/pg_pub)",
      tags: ["infra"],
    });
  });

  const match = (query: string) => {
    const expression = ftsMatchExpression(query);
    assert(Result.isSuccess(expression));
    return expression.value;
  };

  it("viewer search only sees the published revision", async () => {
    const viewer = readScope(context({ spc_eng: "viewer" }, "user:sam"));
    const hits = unwrap(
      await repos.search.searchPublished({ scope: viewer, match: match("deploy"), limit: 20 }),
    );
    expect(hits.map((hit) => hit.title)).toEqual(["Workers deploy guide"]);
    expect(
      unwrap(
        await repos.search.searchAuthoring({ scope: viewer, match: match("deploy"), limit: 20 }),
      ),
    ).toEqual([]);
    // the draft-only term is not findable (no title / snippet / count leak)
    expect(
      unwrap(
        await repos.search.searchPublished({
          scope: viewer,
          match: match("secretplan"),
          limit: 20,
        }),
      ),
    ).toEqual([]);
  });

  it("editor search additionally sees drafts", async () => {
    const editor = readScope(context({ spc_eng: "editor" }, "user:alex"));
    const hits = unwrap(
      await repos.search.searchAuthoring({ scope: editor, match: match("secretplan"), limit: 20 }),
    );
    expect(hits.map((hit) => hit.pageId).sort()).toEqual(["pg_draft", "pg_pub"]);
  });

  it("outsiders only see organization-visible content", async () => {
    const outsider = readScope(context({}, "user:riley"));
    expect(unwrap(await repos.search.listPublished({ scope: outsider, limit: 20 }))).toEqual([]);
    expect(unwrap(await repos.search.spaceActivity(outsider))).toEqual([]);
  });

  it("backlinks come from published revisions only", async () => {
    const owner = readScope(context({ spc_eng: "owner" }, "user:yuki"));
    // the only link to pg_pub lives in an unpublished draft
    expect(
      unwrap(await repos.search.backlinks({ scope: owner, pageId: "pg_pub", limit: 10 })),
    ).toEqual([]);
    await publish("pg_draft", "pub_2", 1);
    const viewer = readScope(context({ spc_eng: "viewer" }, "user:sam"));
    expect(
      unwrap(await repos.search.backlinks({ scope: viewer, pageId: "pg_pub", limit: 10 })),
    ).toEqual([{ pageId: "pg_draft", spaceKey: "engineering", title: "Deploy secretplan draft" }]);
    const outsider = readScope(context({}, "user:riley"));
    expect(
      unwrap(await repos.search.backlinks({ scope: outsider, pageId: "pg_pub", limit: 10 })),
    ).toEqual([]);
  });

  it("reindex is idempotent and tracks the current published revision", async () => {
    unwrap(await repos.search.reindexPublished("pg_pub"));
    unwrap(await repos.search.reindexPublished("pg_pub"));
    const rows = db.db
      .prepare("SELECT count(*) AS total FROM published_page_fts WHERE page_id = 'pg_pub'")
      .get() as {
      total: number;
    };
    expect(rows.total).toBe(1);
    await publish("pg_pub", "pub_3", 2);
    const viewer = readScope(context({ spc_eng: "viewer" }, "user:sam"));
    const hits = unwrap(
      await repos.search.searchPublished({ scope: viewer, match: match("secretplan"), limit: 20 }),
    );
    expect(hits.map((hit) => hit.revisionNumber)).toEqual([2]);
  });
});

describe("effect ledger and notifications", () => {
  it("dedupes notification deliveries per snapshot and watcher", async () => {
    await createPage({ id: "pg_a", title: "Deploy", body: "v1" });
    await snapshotFromDraft("pg_a", "pub_1", 1);
    unwrap(await repos.publications.commitPublish({ snapshotId: "pub_1", now: NOW }));
    const first = unwrap(
      await repos.effects.deliverNotifications({
        snapshotId: "pub_1",
        pageId: "pg_a",
        watcherIds: ["user:sam", "user:alex"],
        now: NOW,
      }),
    );
    const replay = unwrap(
      await repos.effects.deliverNotifications({
        snapshotId: "pub_1",
        pageId: "pg_a",
        watcherIds: ["user:sam", "user:alex"],
        now: NOW,
      }),
    );
    expect([first, replay]).toEqual([2, 0]);

    const failed = unwrap(
      await repos.effects.record({
        snapshotId: "pub_1",
        effect: "watcher_notification",
        status: "failed",
        errorCode: "notifier_unavailable",
        now: NOW,
      }),
    );
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(unwrap(await repos.effects.failedForPages(["pg_a"]))).toHaveLength(1);
    const recovered = unwrap(
      await repos.effects.record({
        snapshotId: "pub_1",
        effect: "watcher_notification",
        status: "succeeded",
        errorCode: null,
        now: NOW,
      }),
    );
    expect(recovered).toMatchObject({ status: "succeeded", attempts: 2 });
  });
});
