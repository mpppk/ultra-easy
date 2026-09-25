import { Result } from "@praha/byethrow";
import { z } from "zod";

import { isStale, STALE_AFTER_DAYS } from "@app/knowledge-core";
import type { KnowledgeRepositories } from "@app/knowledge-d1";

/**
 * Primitive Knowledge Actions exposed to the ultra-easy MCP Gateway (#167).
 * Each tool is the downstream mutation of one ActionType; Authorization /
 * Approval / Re-Authorization already happened in ultra-easy, so the tools only
 * enforce Knowledge invariants (snapshot validation, lifecycle CAS, dedupe).
 */

export type ToolDependencies = {
  repos: KnowledgeRepositories;
  now: () => string;
};

export type ToolOutcome =
  | { type: "success"; data: Record<string, unknown> }
  /** Business / tool-level failure. `retriable` failures are not deduped. */
  | {
      type: "error";
      code: string;
      message: string;
      retriable: boolean;
      data?: Record<string, unknown>;
    };

type ToolDefinition<S extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  /** Only advertised where a persistent downstream dedupe exists. */
  guaranteeLevel: "idempotent" | "read_only";
  run: (input: z.infer<S>, dependencies: ToolDependencies) => Promise<ToolOutcome>;
};

const ok = (data: Record<string, unknown>): ToolOutcome => ({ type: "success", data });
const fail = (
  code: string,
  message: string,
  retriable = false,
  data?: Record<string, unknown>,
): ToolOutcome => ({ type: "error", code, message, retriable, ...(data ? { data } : {}) });
const storeFailure = (error: { message: string }): ToolOutcome =>
  fail("knowledge_store_unavailable", error.message, true);

const snapshotInput = z.object({ publicationSnapshotId: z.string().min(1).max(64) });
const pageInput = z.object({ pageId: z.string().min(1).max(64) });

export const FAULT_SEARCH_INDEX = "fault.search_index";
export const FAULT_NOTIFIER = "fault.notifier";

async function faultActive(dependencies: ToolDependencies, key: string): Promise<boolean> {
  const value = await dependencies.repos.effects.demoSetting(key);
  return Result.isSuccess(value) && value.value === "on";
}

function define<S extends z.ZodType>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}

export const KNOWLEDGE_TOOLS = [
  define({
    name: "knowledge.publication.get",
    title: "Get publication snapshot",
    description: "Reads an immutable PublicationSnapshot and the revision it pins.",
    input: snapshotInput,
    readOnly: true,
    guaranteeLevel: "read_only",
    async run(input, { repos }) {
      const snapshot = await repos.revisions.findSnapshot(input.publicationSnapshotId);
      if (Result.isFailure(snapshot)) return storeFailure(snapshot.error);
      if (!snapshot.value) return fail("publication_snapshot_not_found", "unknown snapshot");
      const [revision, page, space] = await Promise.all([
        repos.revisions.find(snapshot.value.revisionId),
        repos.pages.find(snapshot.value.pageId),
        repos.spaces.findById(snapshot.value.spaceId),
      ]);
      if (Result.isFailure(revision)) return storeFailure(revision.error);
      if (Result.isFailure(page)) return storeFailure(page.error);
      if (Result.isFailure(space)) return storeFailure(space.error);
      if (!revision.value || !page.value || !space.value) {
        return fail("publication_snapshot_not_found", "snapshot references are missing");
      }
      return ok({
        snapshot: snapshot.value,
        revision: {
          id: revision.value.id,
          number: revision.value.number,
          title: revision.value.title,
          tags: revision.value.tags,
          body: revision.value.body,
        },
        page: { id: page.value.id, ownerId: page.value.ownerId },
        space: { id: space.value.id, key: space.value.key, name: space.value.name },
      });
    },
  }),
  define({
    name: "knowledge.revision.publish",
    title: "Publish revision",
    description:
      "Publishes exactly the revision and settings pinned by a PublicationSnapshot " +
      "(compare-and-swap on the page lifecycle version).",
    input: snapshotInput,
    readOnly: false,
    guaranteeLevel: "idempotent",
    async run(input, { repos, now }) {
      const committed = await repos.publications.commitPublish({
        snapshotId: input.publicationSnapshotId,
        now: now(),
      });
      if (Result.isFailure(committed)) return storeFailure(committed.error);
      if (!committed.value) return fail("publication_snapshot_not_found", "unknown snapshot");
      const { outcome, snapshot } = committed.value;
      if (outcome.status === "conflict") {
        return fail(
          "publication_conflict",
          outcome.reason === "archived"
            ? "the page was archived after this publication was requested"
            : `lifecycle version mismatch (expected ${outcome.expectedLifecycleVersion}, actual ${outcome.actualLifecycleVersion})`,
          false,
          {
            reason: outcome.reason,
            expectedLifecycleVersion: outcome.expectedLifecycleVersion,
            actualLifecycleVersion: outcome.actualLifecycleVersion,
          },
        );
      }
      return ok({
        status: "published",
        pageId: snapshot.pageId,
        revisionId: snapshot.revisionId,
        revisionNumber: snapshot.revisionNumber,
      });
    },
  }),
  define({
    name: "knowledge.search.reindex",
    title: "Reindex published page",
    description: "Upserts the published search index row of the snapshot's page.",
    input: snapshotInput,
    readOnly: false,
    guaranteeLevel: "idempotent",
    async run(input, dependencies) {
      const { repos, now } = dependencies;
      const snapshot = await repos.revisions.findSnapshot(input.publicationSnapshotId);
      if (Result.isFailure(snapshot)) return storeFailure(snapshot.error);
      if (!snapshot.value) return fail("publication_snapshot_not_found", "unknown snapshot");
      if (await faultActive(dependencies, FAULT_SEARCH_INDEX)) {
        const recorded = await repos.effects.record({
          snapshotId: snapshot.value.id,
          effect: "search_reindex",
          status: "failed",
          errorCode: "search_index_unavailable",
          now: now(),
        });
        if (Result.isFailure(recorded)) return storeFailure(recorded.error);
        return fail("search_index_unavailable", "search index temporarily unavailable", true);
      }
      const indexed = await repos.search.reindexPublished(snapshot.value.pageId);
      if (Result.isFailure(indexed)) return storeFailure(indexed.error);
      const recorded = await repos.effects.record({
        snapshotId: snapshot.value.id,
        effect: "search_reindex",
        status: "succeeded",
        errorCode: null,
        now: now(),
      });
      if (Result.isFailure(recorded)) return storeFailure(recorded.error);
      return ok({ indexedRevisionId: indexed.value.indexedRevisionId });
    },
  }),
  define({
    name: "knowledge.watchers.notify",
    title: "Notify page watchers",
    description:
      "Delivers in-app notifications for a published snapshot. Deliveries are " +
      "deduplicated per (snapshot, watcher).",
    input: snapshotInput,
    readOnly: false,
    guaranteeLevel: "idempotent",
    async run(input, dependencies) {
      const { repos, now } = dependencies;
      const snapshot = await repos.revisions.findSnapshot(input.publicationSnapshotId);
      if (Result.isFailure(snapshot)) return storeFailure(snapshot.error);
      if (!snapshot.value) return fail("publication_snapshot_not_found", "unknown snapshot");
      const outcome = await repos.revisions.findOutcome(snapshot.value.id);
      if (Result.isFailure(outcome)) return storeFailure(outcome.error);
      if (outcome.value?.status !== "published") {
        return fail("publication_not_published", "only published snapshots notify watchers");
      }
      if (await faultActive(dependencies, FAULT_NOTIFIER)) {
        const recorded = await repos.effects.record({
          snapshotId: snapshot.value.id,
          effect: "watcher_notification",
          status: "failed",
          errorCode: "notifier_unavailable",
          now: now(),
        });
        if (Result.isFailure(recorded)) return storeFailure(recorded.error);
        return fail(
          "notifier_unavailable",
          "downstream notification temporarily unavailable",
          true,
        );
      }
      const watchers = await repos.pages.listWatchers(snapshot.value.pageId);
      if (Result.isFailure(watchers)) return storeFailure(watchers.error);
      const recipients = watchers.value.filter((id) => id !== snapshot.value?.createdBy);
      const delivered = await repos.effects.deliverNotifications({
        snapshotId: snapshot.value.id,
        pageId: snapshot.value.pageId,
        watcherIds: recipients,
        now: now(),
      });
      if (Result.isFailure(delivered)) return storeFailure(delivered.error);
      const recorded = await repos.effects.record({
        snapshotId: snapshot.value.id,
        effect: "watcher_notification",
        status: "succeeded",
        errorCode: null,
        now: now(),
      });
      if (Result.isFailure(recorded)) return storeFailure(recorded.error);
      return ok({ recipients: recipients.length, newDeliveries: delivered.value });
    },
  }),
  define({
    name: "knowledge.pages.list_stale",
    title: "List stale pages",
    description: "Published pages of a space not published or reviewed recently.",
    input: z.object({
      spaceId: z.string().min(1).max(64),
      staleAfterDays: z.number().int().min(1).max(3650).default(STALE_AFTER_DAYS),
    }),
    readOnly: true,
    guaranteeLevel: "read_only",
    async run(input, { repos, now }) {
      const current = new Date(now());
      const before = new Date(
        current.getTime() - input.staleAfterDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const pages = await repos.pages.listStale({ before, spaceId: input.spaceId, limit: 20 });
      if (Result.isFailure(pages)) return storeFailure(pages.error);
      return ok({
        pages: pages.value
          .filter((page) => isStale(page, current, input.staleAfterDays))
          .map((page) => ({
            pageId: page.id,
            ownerId: page.ownerId,
            publishedAt: page.publishedAt,
            lastReviewedAt: page.lastReviewedAt,
          })),
      });
    },
  }),
  define({
    name: "knowledge.page.get_published",
    title: "Get published page",
    description:
      "Current published revision of a page (never drafts). Used as LLM input by " +
      "maintenance workflows.",
    input: pageInput,
    readOnly: true,
    guaranteeLevel: "read_only",
    async run(input, { repos }) {
      const page = await repos.pages.find(input.pageId);
      if (Result.isFailure(page)) return storeFailure(page.error);
      if (!page.value?.publishedRevisionId || page.value.status !== "active") {
        return fail("page_not_found", "no published revision");
      }
      const revision = await repos.revisions.find(page.value.publishedRevisionId);
      if (Result.isFailure(revision)) return storeFailure(revision.error);
      if (!revision.value) return fail("page_not_found", "no published revision");
      return ok({
        pageId: page.value.id,
        ownerId: page.value.ownerId,
        revisionNumber: revision.value.number,
        title: revision.value.title,
        body: revision.value.body,
        tags: revision.value.tags,
        publishedAt: page.value.publishedAt,
        lastReviewedAt: page.value.lastReviewedAt,
      });
    },
  }),
  define({
    name: "knowledge.page.mark_reviewed",
    title: "Record page review",
    description:
      "Records the outcome of a freshness review (reviewed: resets the stale clock; " +
      "update_needed: leaves an attention state for the owner).",
    input: pageInput.extend({ outcome: z.enum(["reviewed", "update_needed"]) }),
    readOnly: false,
    guaranteeLevel: "idempotent",
    async run(input, { repos, now }) {
      const changed = await repos.pages.setReviewState({
        pageId: input.pageId,
        state: input.outcome === "reviewed" ? "current" : "update_needed",
        now: now(),
      });
      if (Result.isFailure(changed)) return storeFailure(changed.error);
      if (changed.value === 0) return fail("page_not_active", "page is missing or archived");
      return ok({ pageId: input.pageId, reviewState: input.outcome });
    },
  }),
  define({
    name: "knowledge.page.archive",
    title: "Archive page",
    description: "Archives an active page (lifecycle transition; removes it from search).",
    input: pageInput,
    readOnly: false,
    guaranteeLevel: "idempotent",
    async run(input, { repos, now }) {
      const archived = await repos.pages.archive(input.pageId, now());
      if (Result.isFailure(archived)) return storeFailure(archived.error);
      if (!archived.value) return fail("page_not_found", "unknown page");
      return ok({
        pageId: input.pageId,
        status: archived.value.page.status,
        lifecycleVersion: archived.value.page.lifecycleVersion,
        changed: archived.value.type === "transitioned",
      });
    },
  }),
] as const;

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOLS)[number]["name"];

export function findTool(name: string) {
  return KNOWLEDGE_TOOLS.find((tool) => tool.name === name) ?? null;
}

export function toolDescriptors() {
  return KNOWLEDGE_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input" }),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.name === "knowledge.page.archive",
      idempotentHint: true,
    },
    _meta: { "dev.ultra-easy/guaranteeLevel": tool.guaranteeLevel },
  }));
}

/** Validates arguments against the tool's schema and runs it. */
export async function runTool(
  name: string,
  args: unknown,
  dependencies: ToolDependencies,
): Promise<ToolOutcome | null> {
  const tool = findTool(name);
  if (!tool) return null;
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return fail("invalid_arguments", z.prettifyError(parsed.error));
  }
  // Each tool's `run` accepts exactly its own schema output, validated above.
  const run = tool.run as (input: unknown, deps: ToolDependencies) => Promise<ToolOutcome>;
  return run(parsed.data, dependencies);
}
