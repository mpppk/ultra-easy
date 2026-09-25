import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  canReadPublished,
  capabilitiesForRole,
  decidePublishCommit,
  extractPageLinks,
  ftsMatchExpression,
  hasUnpublishedChanges,
  isStale,
  pageAccess,
  readScope,
  saveDraftInputSchema,
  validatePublicationSnapshot,
  type Draft,
  type KnowledgeContext,
  type SpaceRole,
} from "./index.ts";

function context(roles: Record<string, SpaceRole>, principalId = "user:yuki"): KnowledgeContext {
  return {
    organizationId: "org_acme",
    principal: { id: principalId, displayName: principalId },
    spaceRoles: new Map(Object.entries(roles)),
  };
}

const publishedPage = {
  spaceId: "spc_eng",
  ownerId: "user:alex",
  status: "active" as const,
  publishedRevisionId: "rev_1",
  publishedVisibility: "space" as const,
};

describe("authorization mapping", () => {
  it("maps viewer / editor / owner to growing capability sets", () => {
    expect([...capabilitiesForRole("viewer")]).toEqual(["knowledge.page.read_published"]);
    expect(capabilitiesForRole("editor").has("knowledge.page.read_draft")).toBe(true);
    expect(capabilitiesForRole("editor").has("knowledge.page.read_history")).toBe(false);
    expect(capabilitiesForRole("owner").has("knowledge.page.read_history")).toBe(true);
    expect(capabilitiesForRole(null).size).toBe(0);
  });

  it("reads published content by visibility, never drafts for viewers", () => {
    expect(canReadPublished(context({}), publishedPage)).toBe(false);
    expect(canReadPublished(context({ spc_eng: "viewer" }), publishedPage)).toBe(true);
    expect(
      canReadPublished(context({}), { ...publishedPage, publishedVisibility: "organization" }),
    ).toBe(true);
    const privatePage = { ...publishedPage, publishedVisibility: "private" as const };
    expect(canReadPublished(context({ spc_eng: "editor" }), privatePage)).toBe(false);
    expect(canReadPublished(context({ spc_eng: "owner" }), privatePage)).toBe(true);
    expect(canReadPublished(context({}, "user:alex"), privatePage)).toBe(true);
    expect(
      canReadPublished(context({ spc_eng: "owner" }), {
        ...publishedPage,
        publishedRevisionId: null,
        publishedVisibility: null,
      }),
    ).toBe(false);

    const viewer = pageAccess(context({ spc_eng: "viewer" }), publishedPage);
    expect(viewer).toMatchObject({ readPublished: true, readDraft: false, edit: false });
    const editor = pageAccess(context({ spc_eng: "editor" }), publishedPage);
    expect(editor).toMatchObject({ readDraft: true, edit: true, publish: true, archive: false });
    const archivedOwner = pageAccess(context({ spc_eng: "owner" }), {
      ...publishedPage,
      status: "archived",
    });
    expect(archivedOwner).toMatchObject({ edit: false, publish: false, restore: true });
  });

  it("derives a query scope before any data is read", () => {
    expect(readScope(context({ spc_b: "viewer", spc_a: "owner", spc_c: "editor" }))).toEqual({
      organizationId: "org_acme",
      principalId: "user:yuki",
      memberSpaceIds: ["spc_a", "spc_b", "spc_c"],
      ownerSpaceIds: ["spc_a"],
      authoringSpaceIds: ["spc_a", "spc_c"],
    });
  });
});

describe("publication snapshot", () => {
  const access = pageAccess(context({ spc_eng: "editor" }), publishedPage);
  const valid = {
    access,
    page: { id: "pg_1", spaceId: "spc_eng", status: "active" as const, lifecycleVersion: 7 },
    revision: { pageId: "pg_1" },
    spaceId: "spc_eng",
    visibility: "organization" as const,
    sensitivity: "confidential" as const,
    expectedLifecycleVersion: 7,
  };

  it("validates page / space / lifecycle / capability server-side", () => {
    expect(Result.isSuccess(validatePublicationSnapshot(valid))).toBe(true);
    const code = (input: Parameters<typeof validatePublicationSnapshot>[0]) => {
      const result = validatePublicationSnapshot(input);
      return Result.isFailure(result) ? result.error.code : "ok";
    };
    expect(code({ ...valid, revision: { pageId: "pg_other" } })).toBe("revision_page_mismatch");
    expect(code({ ...valid, spaceId: "spc_other" })).toBe("space_mismatch");
    expect(code({ ...valid, expectedLifecycleVersion: 6 })).toBe("lifecycle_version_mismatch");
    expect(code({ ...valid, page: { ...valid.page, status: "archived" } })).toBe("page_archived");
    expect(
      code({ ...valid, access: pageAccess(context({ spc_eng: "viewer" }), publishedPage) }),
    ).toBe("forbidden");
  });

  it("CAS: newer publication or archive wins over an old pending snapshot", () => {
    const snapshot = { id: "pub_100", expectedLifecycleVersion: 7 };
    expect(
      decidePublishCommit(
        { status: "active", lifecycleVersion: 7, publishedSnapshotId: null },
        snapshot,
      ),
    ).toEqual({ type: "commit" });
    expect(
      decidePublishCommit(
        { status: "active", lifecycleVersion: 8, publishedSnapshotId: "pub_101" },
        snapshot,
      ),
    ).toEqual({
      type: "conflict",
      reason: "lifecycle_mismatch",
      expectedLifecycleVersion: 7,
      actualLifecycleVersion: 8,
    });
    expect(
      decidePublishCommit(
        { status: "archived", lifecycleVersion: 8, publishedSnapshotId: null },
        snapshot,
      ),
    ).toMatchObject({ type: "conflict", reason: "archived" });
    // transport replay of the committed snapshot is not a conflict
    expect(
      decidePublishCommit(
        { status: "active", lifecycleVersion: 8, publishedSnapshotId: "pub_100" },
        snapshot,
      ),
    ).toEqual({ type: "already_published" });
  });

  it("detects unpublished content and settings changes", () => {
    const draft: Draft = {
      pageId: "pg_1",
      title: "T",
      body: "B",
      tags: ["a"],
      visibility: "space",
      sensitivity: "normal",
      version: 1,
      updatedBy: "user:yuki",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const page = { publishedVisibility: "space" as const, publishedSensitivity: "normal" as const };
    const revision = { title: "T", body: "B", tags: ["a"] };
    expect(hasUnpublishedChanges(draft, page, null)).toBe(true);
    expect(hasUnpublishedChanges(draft, page, revision)).toBe(false);
    expect(hasUnpublishedChanges({ ...draft, body: "C" }, page, revision)).toBe(true);
    expect(hasUnpublishedChanges({ ...draft, sensitivity: "internal" }, page, revision)).toBe(true);
  });
});

describe("text helpers", () => {
  it("builds FTS expressions that neutralize operators", () => {
    expect(ftsMatchExpression('deploy "OR" NEAR(x)')).toEqual(
      Result.succeed('"deploy"* "OR"* "NEARx"*'),
    );
    const empty = ftsMatchExpression('  " * ');
    expect(Result.isFailure(empty) && empty.error.code).toBe("empty_query");
  });

  it("extracts page links from Markdown", () => {
    expect(
      extractPageLinks(
        "See [a](/spaces/eng/pages/pg_abc) and [b](https://kb.example/spaces/hr/pages/pg_def) " +
          "and again [a](/spaces/eng/pages/pg_abc) but not [c](/elsewhere/pg_x)",
      ),
    ).toEqual(["pg_abc", "pg_def"]);
  });

  it("treats pages without a recent publish / review as stale", () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    const page = {
      status: "active",
      publishedAt: "2026-05-01T00:00:00.000Z",
      lastReviewedAt: null,
    };
    expect(isStale(page, now)).toBe(true);
    expect(isStale({ ...page, lastReviewedAt: "2026-09-01T00:00:00.000Z" }, now)).toBe(false);
    expect(isStale({ ...page, publishedAt: null }, now)).toBe(false);
  });

  it("validates draft input and deduplicates tags", () => {
    const parsed = saveDraftInputSchema.safeParse({
      title: "  Deploy ",
      body: "x",
      tags: ["ops", "ops", "Infra"],
      visibility: "space",
      sensitivity: "normal",
      expectedVersion: 1,
    });
    expect(parsed.success && parsed.data).toMatchObject({
      title: "Deploy",
      tags: ["ops", "Infra"],
    });
    expect(
      saveDraftInputSchema.safeParse({
        title: "",
        body: "",
        tags: [],
        visibility: "public",
        sensitivity: "normal",
        expectedVersion: 0,
      }).success,
    ).toBe(false);
  });
});
