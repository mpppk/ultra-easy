import { Result } from "@praha/byethrow";
import { z } from "zod";

import {
  canSeePage,
  createPageInputSchema,
  createSpaceInputSchema,
  ftsMatchExpression,
  hasSpaceCapability,
  hasUnpublishedChanges,
  HUMAN_REVIEW_DECISIONS,
  newId,
  pageAccess,
  plainSnippet,
  publishInputSchema,
  readScope,
  roleIn,
  sameContent,
  saveDraftInputSchema,
  searchInputSchema,
  spaceKeySchema,
  validatePublicationSnapshot,
  type Draft,
  type KnowledgeContext,
  type Page,
  type PageAccess,
  type PublicationEffect,
  type PublicationOutcome,
  type PublicationSnapshot,
  type Revision,
  type Space,
} from "@app/knowledge-core";
import type { KnowledgeRepositories, KnowledgeStoreError } from "@app/knowledge-d1";

import type {
  ApprovalRuleView,
  AttentionItem,
  AutomationCategory,
  AutomationDetailView,
  AutomationItemView,
  AutomationView,
  EditView,
  HomeView,
  PageBadge,
  PageRowView,
  PageView,
  PrincipalView,
  PublicationPanelView,
  PublicationState,
  RevisionDetailView,
  RevisionSummaryView,
  SearchResultView,
  SearchView,
  SpaceDetailView,
  SpaceSettingsView,
  SpacesView,
  SpaceSummary,
  StepStatus,
} from "../shared/api.ts";
import type {
  CompiledPolicy,
  CompiledPolicyRule,
  RunNode,
  UltraEasyClient,
  UltraEasyError,
  WorkflowRunView,
} from "../ultra-easy/client.ts";
import { manualMaintenanceKey, startSpaceMaintenance } from "./maintenance.ts";
import { forbidden, KnowledgeServiceError, notFound, platformError, storeError } from "./errors.ts";

type ServiceResult<T> = Result.ResultAsync<T, KnowledgeServiceError>;

export type KnowledgeServiceDependencies = {
  repos: KnowledgeRepositories;
  ultraEasy: UltraEasyClient;
  now: () => string;
};

async function fromStore<T>(result: Result.ResultAsync<T, KnowledgeStoreError>): ServiceResult<T> {
  const resolved = await result;
  return Result.isFailure(resolved) ? Result.fail(storeError(resolved.error)) : resolved;
}

async function fromPlatform<T>(result: Result.ResultAsync<T, UltraEasyError>): ServiceResult<T> {
  const resolved = await result;
  return Result.isFailure(resolved) ? Result.fail(platformError(resolved.error)) : resolved;
}

function validation(error: z.ZodError): KnowledgeServiceError {
  return new KnowledgeServiceError(
    "validation_error",
    "Check the highlighted fields",
    z.prettifyError(error),
  );
}

type LoadedPage = { space: Space; page: Page; access: PageAccess };

const EFFECT_NODE: Record<string, "search_reindex" | "watcher_notification"> = {
  reindex: "search_reindex",
  notify: "watcher_notification",
};

const RULE_TEXT: Record<ApprovalRuleView["key"], { title: string; description: string }> = {
  publish_confidential: {
    title: "Publish confidential documents",
    description: "Require approval when a page labeled as confidential is published.",
  },
  publish_organization: {
    title: "Organization-wide publication",
    description: "Require approval when a page is published to the whole organization.",
  },
  archive: {
    title: "Archive",
    description: "Require approval to archive a page requested by someone other than its owner.",
  },
};

export const approvalRulesInputSchema = z.object({
  rules: z
    .array(
      z.object({
        key: z.enum(["publish_confidential", "publish_organization", "archive"]),
        requireApproval: z.boolean(),
        approver: z.enum(["space_owners", "page_owner"]),
      }),
    )
    .length(3)
    .refine((rules) => new Set(rules.map((rule) => rule.key)).size === 3, "Each rule once"),
});

/** Knowledge presets -> ultra-easy policy binding (server-side compiler). */
export function compileApprovalRules(
  rules: z.infer<typeof approvalRulesInputSchema>["rules"],
): CompiledPolicy {
  const compiled: CompiledPolicyRule[] = [];
  for (const key of ["publish_confidential", "publish_organization", "archive"] as const) {
    const rule = rules.find((entry) => entry.key === key);
    if (!rule?.requireApproval) continue;
    if (key === "archive") {
      compiled.push({
        key,
        actionType: "knowledge.page.archive",
        when: rule.approver === "page_owner" ? { requesterIsNot: "page_owner" } : { always: true },
        approvers: rule.approver,
      });
    } else {
      compiled.push({
        key,
        actionType: "knowledge.revision.publish",
        when:
          key === "publish_confidential"
            ? { field: "sensitivity", equals: "confidential" }
            : { field: "visibility", equals: "organization" },
        approvers: rule.approver,
      });
    }
  }
  return { rules: compiled };
}

/** ultra-easy policy binding -> Knowledge presets (unknown rules are ignored). */
export function decompileApprovalRules(policy: CompiledPolicy): ApprovalRuleView[] {
  return (["publish_confidential", "publish_organization", "archive"] as const).map((key) => {
    const rule = policy.rules.find((entry) => entry.key === key);
    return {
      key,
      ...RULE_TEXT[key],
      requireApproval: rule !== undefined,
      approver: rule?.approvers ?? (key === "archive" ? "page_owner" : "space_owners"),
    };
  });
}

function stepStatus(node: RunNode): StepStatus {
  if (node.errorCode === "publication_conflict") return "conflict";
  switch (node.status) {
    case "succeeded":
      return "done";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

export class KnowledgeService {
  private readonly repos: KnowledgeRepositories;
  private readonly ultraEasy: UltraEasyClient;
  private readonly now: () => string;

  constructor(
    dependencies: KnowledgeServiceDependencies,
    readonly context: KnowledgeContext,
    private readonly directory: ReadonlyMap<string, PrincipalView>,
  ) {
    this.repos = dependencies.repos;
    this.ultraEasy = dependencies.ultraEasy;
    this.now = dependencies.now;
  }

  private get organizationId() {
    return this.context.organizationId;
  }

  private get me(): PrincipalView {
    return this.context.principal;
  }

  private person(id: string): PrincipalView {
    return this.directory.get(id) ?? { id, displayName: id };
  }

  private scope() {
    return readScope(this.context);
  }

  // ---------------------------------------------------------------------------
  // loading helpers (authorization decided here, once)
  // ---------------------------------------------------------------------------

  /** Space Detail requires a role; unknown and forbidden look the same. */
  private async loadSpace(key: string): ServiceResult<{ space: Space; summary: SpaceSummary }> {
    const parsed = spaceKeySchema.safeParse(key);
    if (!parsed.success) return Result.fail(notFound());
    const space = await fromStore(this.repos.spaces.findByKey(this.organizationId, parsed.data));
    if (Result.isFailure(space)) return space;
    const role = space.value ? roleIn(this.context, space.value.id) : null;
    if (!space.value || !role) return Result.fail(notFound());
    const activity = await fromStore(this.repos.search.spaceActivity(this.scope()));
    if (Result.isFailure(activity)) return activity;
    const stats = activity.value.find((entry) => entry.spaceId === space.value?.id);
    return Result.succeed({
      space: space.value,
      summary: {
        id: space.value.id,
        key: space.value.key,
        name: space.value.name,
        description: space.value.description,
        role,
        publishedPageCount: stats?.publishedPageCount ?? 0,
        lastActivityAt: stats?.lastActivityAt ?? null,
      },
    });
  }

  private async loadPage(spaceKey: string, pageId: string): ServiceResult<LoadedPage> {
    const key = spaceKeySchema.safeParse(spaceKey);
    if (!key.success) return Result.fail(notFound());
    const space = await fromStore(this.repos.spaces.findByKey(this.organizationId, key.data));
    if (Result.isFailure(space)) return space;
    if (!space.value) return Result.fail(notFound());
    const page = await fromStore(this.repos.pages.find(pageId));
    if (Result.isFailure(page)) return page;
    if (!page.value || page.value.spaceId !== space.value.id) return Result.fail(notFound());
    const access = pageAccess(this.context, page.value);
    if (!canSeePage(access)) return Result.fail(notFound());
    return Result.succeed({ space: space.value, page: page.value, access });
  }

  private async titleOf(page: Page, access: PageAccess): Promise<string> {
    if (access.readDraft) {
      const draft = await this.repos.pages.findDraft(page.id);
      if (Result.isSuccess(draft) && draft.value) return draft.value.title;
    }
    if (access.readPublished && page.publishedRevisionId) {
      const revision = await this.repos.revisions.find(page.publishedRevisionId);
      if (Result.isSuccess(revision) && revision.value) return revision.value.title;
    }
    return "Untitled page";
  }

  // ---------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------

  async home(): ServiceResult<HomeView> {
    const scope = this.scope();
    const failedSections: HomeView["failedSections"] = [];
    const [published, authoring] = await Promise.all([
      this.repos.search.listPublished({ scope, limit: 6 }),
      this.repos.search.listAuthoring({ scope, limit: 100 }),
    ]);
    if (Result.isFailure(published)) failedSections.push("recentlyPublished");
    if (Result.isFailure(authoring)) failedSections.push("recentlyEdited");

    const recentlyEdited: HomeView["recentlyEdited"] = [];
    for (const row of Result.isSuccess(authoring) ? authoring.value : []) {
      const neverPublished = row.publishedRevisionId === null;
      const changed =
        neverPublished ||
        !sameContent(row, {
          title: row.publishedTitle ?? "",
          body: row.publishedBody ?? "",
          tags: row.publishedTags ?? [],
        }) ||
        row.visibility !== row.publishedVisibility ||
        row.sensitivity !== row.publishedSensitivity;
      if (!changed) continue;
      recentlyEdited.push({
        pageId: row.pageId,
        spaceKey: row.spaceKey,
        spaceName: row.spaceName,
        title: row.title,
        editedAt: row.updatedAt,
        state: neverPublished ? "draft" : "unpublished_changes",
      });
      if (recentlyEdited.length === 4) break;
    }

    const attention = await this.attention(Result.isSuccess(authoring) ? authoring.value : []);
    if (Result.isFailure(attention)) failedSections.push("attention");

    return Result.succeed({
      recentlyPublished: (Result.isSuccess(published) ? published.value : []).map((row) => ({
        pageId: row.pageId,
        spaceKey: row.spaceKey,
        spaceName: row.spaceName,
        title: row.title,
        publishedAt: row.publishedAt,
        owner: this.person(row.ownerId),
        visibility: row.visibility,
        sensitivity: row.sensitivity,
      })),
      recentlyEdited,
      attention: Result.isSuccess(attention) ? attention.value : [],
      creatableSpaces: await this.creatableSpaces(),
      failedSections,
    });
  }

  /** Knowledge lifecycle tasks only (this is not an approval inbox). */
  private async attention(
    authoring: Array<{
      pageId: string;
      spaceId: string;
      spaceKey: string;
      title: string;
      ownerId: string;
      reviewState: string;
    }>,
  ): ServiceResult<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const byPage = new Map(authoring.map((row) => [row.pageId, row]));

    const runs = await fromPlatform(
      this.ultraEasy.listRuns({
        organizationId: this.organizationId,
        spaceIds: this.scope().memberSpaceIds,
        limit: 50,
      }),
    );
    if (Result.isFailure(runs)) return runs;
    const spaceKeys = await this.spaceKeys();
    for (const run of runs.value) {
      for (const input of run.humanInputs) {
        if (input.status !== "waiting" || input.assigneeId !== this.me.id) continue;
        items.push({
          kind: "stale_review",
          runId: run.id,
          pageId: input.subject.pageId,
          spaceKey: spaceKeys.get(run.correlation.spaceId) ?? "",
          title: `${input.subject.title} may be stale`,
          detail: "Owner review requested by maintenance workflow",
        });
      }
      if (
        run.actionType === "knowledge.publish_document" &&
        run.status === "waiting_approval" &&
        run.requestedBy.id === this.me.id &&
        run.correlation.pageId
      ) {
        const page = byPage.get(run.correlation.pageId);
        const approval = run.approvals.find((task) => task.status === "pending");
        if (page && approval) {
          items.push({
            kind: "approval_pending",
            pageId: page.pageId,
            spaceKey: page.spaceKey,
            title: `${page.title} is waiting for approval`,
            detail: "Your publication is waiting in ultra-easy",
            approvalUrl: approval.url,
          });
        }
      }
    }

    for (const row of authoring) {
      if (row.ownerId === this.me.id && row.reviewState === "update_needed") {
        items.push({
          kind: "update_needed",
          pageId: row.pageId,
          spaceKey: row.spaceKey,
          title: `${row.title} needs an update`,
          detail: "Marked as outdated during owner review",
        });
      }
    }

    const conflicts = await fromStore(this.repos.revisions.unresolvedConflictsBy(this.me.id, 5));
    if (Result.isFailure(conflicts)) return conflicts;
    for (const { snapshot, outcome } of conflicts.value) {
      const page = byPage.get(snapshot.pageId);
      if (!page || outcome.status !== "conflict") continue;
      items.push({
        kind: "publication_conflict",
        pageId: page.pageId,
        spaceKey: page.spaceKey,
        title: `Publication conflict on ${page.title}`,
        detail: `Revision #${snapshot.revisionNumber} was not published: the page changed meanwhile`,
      });
    }

    const publishable = authoring.filter((row) =>
      hasSpaceCapability(this.context, row.spaceId, "knowledge.page.publish"),
    );
    const failed = await fromStore(
      this.repos.effects.failedForPages(publishable.map((row) => row.pageId)),
    );
    if (Result.isFailure(failed)) return failed;
    for (const effect of failed.value) {
      const page = byPage.get(effect.pageId);
      if (!page) continue;
      items.push({
        kind: "effect_failed",
        pageId: page.pageId,
        spaceKey: page.spaceKey,
        title:
          effect.effect === "watcher_notification"
            ? "Watcher notification failed"
            : "Search indexing failed",
        detail: `${page.title} · Revision #${effect.revisionNumber}`,
        snapshotId: effect.publicationSnapshotId,
        effect: effect.effect,
      });
    }
    return Result.succeed(items);
  }

  private async creatableSpaces(): Promise<Array<{ key: string; name: string }>> {
    const ids = [...this.context.spaceRoles.keys()].filter((id) =>
      hasSpaceCapability(this.context, id, "knowledge.page.create"),
    );
    const spaces = await this.repos.spaces.listByIds(this.organizationId, ids);
    return Result.isSuccess(spaces)
      ? spaces.value.map((space) => ({ key: space.key, name: space.name }))
      : [];
  }

  private async spaceKeys(): Promise<Map<string, string>> {
    const spaces = await this.repos.spaces.listByIds(this.organizationId, [
      ...this.context.spaceRoles.keys(),
    ]);
    return new Map(
      Result.isSuccess(spaces) ? spaces.value.map((space) => [space.id, space.key]) : [],
    );
  }

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  async spaces(): ServiceResult<SpacesView> {
    const scope = this.scope();
    const [spaces, activity] = await Promise.all([
      fromStore(this.repos.spaces.listByIds(this.organizationId, scope.memberSpaceIds)),
      fromStore(this.repos.search.spaceActivity(scope)),
    ]);
    if (Result.isFailure(spaces)) return spaces;
    if (Result.isFailure(activity)) return activity;
    return Result.succeed({
      canCreateSpace: true,
      spaces: spaces.value.flatMap((space) => {
        const role = roleIn(this.context, space.id);
        if (!role) return [];
        const stats = activity.value.find((entry) => entry.spaceId === space.id);
        return [
          {
            id: space.id,
            key: space.key,
            name: space.name,
            description: space.description,
            role,
            publishedPageCount: stats?.publishedPageCount ?? 0,
            lastActivityAt: stats?.lastActivityAt ?? null,
          },
        ];
      }),
    });
  }

  /** Any organization member may create a space and becomes its owner. */
  async createSpace(body: unknown): ServiceResult<{ key: string }> {
    const input = createSpaceInputSchema.safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const space: Space = {
      id: newId("spc"),
      organizationId: this.organizationId,
      key: input.data.key,
      name: input.data.name,
      description: input.data.description,
      createdBy: this.me.id,
      createdAt: this.now(),
    };
    const created = await fromStore(this.repos.spaces.create(space));
    if (Result.isFailure(created)) return created;
    const granted = await fromPlatform(
      this.ultraEasy.grantSpaceRole({
        organizationId: this.organizationId,
        principalId: this.me.id,
        spaceId: space.id,
        role: "owner",
      }),
    );
    if (Result.isFailure(granted)) return granted;
    return Result.succeed({ key: space.key });
  }

  async spaceDetail(key: string, query: { tag?: string }): ServiceResult<SpaceDetailView> {
    const loaded = await this.loadSpace(key);
    if (Result.isFailure(loaded)) return loaded;
    const { space, summary } = loaded.value;
    const scope = this.scope();
    const tag = query.tag && query.tag.length <= 32 ? query.tag : undefined;
    const authoring = hasSpaceCapability(this.context, space.id, "knowledge.page.read_draft");
    let pages: PageRowView[];
    if (authoring) {
      const rows = await fromStore(
        this.repos.search.listAuthoring({ scope, spaceId: space.id, tag, limit: 200 }),
      );
      if (Result.isFailure(rows)) return rows;
      pages = rows.value.map((row) => ({
        pageId: row.pageId,
        title: row.title,
        tags: row.tags,
        owner: this.person(row.ownerId),
        updatedAt: row.updatedAt,
        badge: authoringBadge(row),
      }));
    } else {
      const rows = await fromStore(
        this.repos.search.listPublished({ scope, spaceId: space.id, tag, limit: 200 }),
      );
      if (Result.isFailure(rows)) return rows;
      pages = rows.value.map((row) => ({
        pageId: row.pageId,
        title: row.title,
        tags: row.tags,
        owner: this.person(row.ownerId),
        updatedAt: row.publishedAt,
        badge: "published",
      }));
    }
    const tags = await fromStore(this.repos.search.tags({ scope, spaceId: space.id }));
    if (Result.isFailure(tags)) return tags;
    return Result.succeed({
      space: summary,
      canCreatePage: hasSpaceCapability(this.context, space.id, "knowledge.page.create"),
      canAdminister: hasSpaceCapability(this.context, space.id, "knowledge.space.administer"),
      canRunMaintenance: hasSpaceCapability(this.context, space.id, "knowledge.space.administer"),
      pages,
      tags: tags.value,
    });
  }

  async createPage(
    key: string,
    body: unknown,
  ): ServiceResult<{ pageId: string; spaceKey: string }> {
    const loaded = await this.loadSpace(key);
    if (Result.isFailure(loaded)) return loaded;
    const { space } = loaded.value;
    if (!hasSpaceCapability(this.context, space.id, "knowledge.page.create"))
      return Result.fail(forbidden());
    const input = createPageInputSchema.safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const now = this.now();
    const pageId = newId("pg");
    const created = await fromStore(
      this.repos.pages.create(
        {
          id: pageId,
          spaceId: space.id,
          ownerId: this.me.id,
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
          createdAt: now,
          updatedAt: now,
        },
        {
          pageId,
          title: input.data.title,
          body: `# ${input.data.title}\n\n`,
          tags: [],
          visibility: "space",
          sensitivity: "internal",
          version: 0,
          updatedBy: this.me.id,
          updatedAt: now,
        },
      ),
    );
    if (Result.isFailure(created)) return created;
    return Result.succeed({ pageId, spaceKey: space.key });
  }

  // ---------------------------------------------------------------------------
  // Page View
  // ---------------------------------------------------------------------------

  async pageView(spaceKey: string, pageId: string): ServiceResult<PageView> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    const { space, page, access } = loaded.value;
    const scope = this.scope();

    const publishedRevision =
      page.publishedRevisionId && access.readPublished
        ? await fromStore(this.repos.revisions.find(page.publishedRevisionId))
        : Result.succeed(null);
    if (Result.isFailure(publishedRevision)) return publishedRevision;
    const draft = access.readDraft
      ? await fromStore(this.repos.pages.findDraft(page.id))
      : Result.succeed(null);
    if (Result.isFailure(draft)) return draft;
    const latest = access.publish
      ? await fromStore(this.repos.revisions.latest(page.id))
      : Result.succeed(null);
    if (Result.isFailure(latest)) return latest;

    const tags = publishedRevision.value?.tags ?? draft.value?.tags ?? [];
    const [related, backlinks, watching, historyCount] = await Promise.all([
      fromStore(this.repos.search.related({ scope, pageId: page.id, tags, limit: 5 })),
      fromStore(this.repos.search.backlinks({ scope, pageId: page.id, limit: 10 })),
      fromStore(this.repos.pages.isWatching(page.id, this.me.id)),
      access.readHistory
        ? fromStore(this.repos.revisions.count(page.id))
        : Promise.resolve(Result.succeed(null)),
    ]);
    if (Result.isFailure(related)) return related;
    if (Result.isFailure(backlinks)) return backlinks;
    if (Result.isFailure(watching)) return watching;
    if (Result.isFailure(historyCount)) return historyCount;

    const publication = access.readDraft
      ? await this.publicationPanel(page, access)
      : Result.succeed(null);
    if (Result.isFailure(publication)) return publication;
    const pendingArchive = access.readDraft ? await this.pendingArchive(page) : null;

    return Result.succeed({
      space: { id: space.id, key: space.key, name: space.name },
      page: {
        id: page.id,
        status: page.status,
        owner: this.person(page.ownerId),
        reviewState: page.reviewState,
      },
      published:
        publishedRevision.value &&
        page.publishedVisibility &&
        page.publishedSensitivity &&
        page.publishedAt
          ? {
              revisionNumber: publishedRevision.value.number,
              title: publishedRevision.value.title,
              body: publishedRevision.value.body,
              tags: publishedRevision.value.tags,
              visibility: page.publishedVisibility,
              sensitivity: page.publishedSensitivity,
              publishedAt: page.publishedAt,
              publishedBy: this.person(page.publishedBy ?? page.ownerId),
            }
          : null,
      draft: draft.value
        ? {
            title: draft.value.title,
            body: draft.value.body,
            tags: draft.value.tags,
            visibility: draft.value.visibility,
            sensitivity: draft.value.sensitivity,
            version: draft.value.version,
            updatedAt: draft.value.updatedAt,
            updatedBy: this.person(draft.value.updatedBy),
            hasUnpublishedChanges: hasUnpublishedChanges(
              draft.value,
              page,
              publishedRevision.value,
            ),
          }
        : null,
      access: {
        edit: access.edit,
        publish: access.publish,
        archive: access.archive,
        restore: access.restore,
        readHistory: access.readHistory,
        watch: access.watch,
      },
      watching: watching.value,
      nextPublication:
        access.publish && draft.value
          ? {
              revisionNumber:
                latest.value && sameContent(draft.value, latest.value)
                  ? latest.value.number
                  : (latest.value?.number ?? 0) + 1,
              reusesRevision: latest.value !== null && sameContent(draft.value, latest.value),
              visibility: draft.value.visibility,
              sensitivity: draft.value.sensitivity,
              draftVersion: draft.value.version,
            }
          : null,
      publication: publication.value,
      pendingArchive,
      historyCount: historyCount.value,
      related: related.value,
      backlinks: backlinks.value,
    });
  }

  private async pendingArchive(page: Page): Promise<PageView["pendingArchive"]> {
    const runs = await this.ultraEasy.listRuns({
      organizationId: this.organizationId,
      spaceIds: [page.spaceId],
      limit: 50,
    });
    if (Result.isFailure(runs)) return null;
    const run = runs.value.find(
      (entry) =>
        entry.actionType === "knowledge.page.archive" &&
        entry.correlation.pageId === page.id &&
        entry.status === "waiting_approval",
    );
    const task = run?.approvals.find((approval) => approval.status === "pending");
    return task ? { approvalUrl: task.url } : null;
  }

  /** Picks the snapshot with the latest activity (creation or outcome). */
  private async currentSnapshot(page: Page): ServiceResult<{
    snapshot: PublicationSnapshot;
    outcome: PublicationOutcome | null;
  } | null> {
    const [snapshots, outcomes] = await Promise.all([
      fromStore(this.repos.revisions.snapshotsForPage(page.id)),
      fromStore(this.repos.revisions.outcomesForPage(page.id)),
    ]);
    if (Result.isFailure(snapshots)) return snapshots;
    if (Result.isFailure(outcomes)) return outcomes;
    const outcomeOf = new Map(outcomes.value.map((outcome) => [outcome.snapshotId, outcome]));
    let best: {
      snapshot: PublicationSnapshot;
      outcome: PublicationOutcome | null;
      at: string;
    } | null = null;
    for (const snapshot of snapshots.value) {
      const outcome = outcomeOf.get(snapshot.id) ?? null;
      const at = outcome?.recordedAt ?? snapshot.createdAt;
      if (!best || at > best.at) best = { snapshot, outcome, at };
    }
    return Result.succeed(best ? { snapshot: best.snapshot, outcome: best.outcome } : null);
  }

  private async publicationPanel(
    page: Page,
    access: PageAccess,
  ): ServiceResult<PublicationPanelView | null> {
    const current = await this.currentSnapshot(page);
    if (Result.isFailure(current)) return current;
    if (!current.value) return Result.succeed(null);
    const { snapshot, outcome } = current.value;
    const [request, effects] = await Promise.all([
      fromStore(this.repos.revisions.findRequest(snapshot.id)),
      fromStore(this.repos.effects.list(snapshot.id)),
    ]);
    if (Result.isFailure(request)) return request;
    if (Result.isFailure(effects)) return effects;
    const run = request.value
      ? await fromPlatform(
          this.ultraEasy.findRunByActionRequest({
            organizationId: this.organizationId,
            actionRequestId: request.value.actionRequestId,
          }),
        )
      : Result.succeed(null);
    // Automation state is optional context: a platform outage must not hide
    // the Knowledge-domain publication result.
    const runView = Result.isSuccess(run) ? run.value : null;
    return Result.succeed(
      this.panel({ snapshot, outcome, effects: effects.value, run: runView, access }),
    );
  }

  private panel(input: {
    snapshot: PublicationSnapshot;
    outcome: PublicationOutcome | null;
    effects: PublicationEffect[];
    run: WorkflowRunView | null;
    access: PageAccess;
  }): PublicationPanelView {
    const { snapshot, outcome, effects, run, access } = input;
    const effectFailed = effects.some(
      (effect) => effect.status === "failed" || effect.status === "unknown",
    );
    let state: PublicationState;
    if (outcome?.status === "conflict") state = "conflict";
    else if (outcome?.status === "published")
      state = effectFailed ? "published_effect_failed" : "published";
    else if (run?.status === "waiting_approval") state = "waiting_approval";
    else if (run?.status === "rejected") state = "rejected";
    else if (run?.status === "cancelled") state = "cancelled";
    else if (run?.status === "running") state = "analyzing";
    else state = "failed_before_publish";

    const effectByKind = new Map(effects.map((effect) => [effect.effect, effect]));
    // Without a run (e.g. imported history) the domain ledger alone tells the story.
    const nodes: RunNode[] =
      run?.nodes ??
      (outcome
        ? [
            {
              key: "publish",
              label: "Publish",
              status: outcome.status === "published" ? "succeeded" : "failed",
              ...(outcome.status === "conflict" ? { errorCode: "publication_conflict" } : {}),
            },
            { key: "reindex", label: "Search index", status: "pending" },
            { key: "notify", label: "Notify watchers", status: "pending" },
          ]
        : []);
    const steps = nodes.map((node) => {
      const effect = EFFECT_NODE[node.key]
        ? effectByKind.get(EFFECT_NODE[node.key] ?? "search_reindex")
        : undefined;
      // The effect ledger is the domain truth: a recovered effect shows as done
      // even though the original run keeps its failed history.
      const status: StepStatus =
        effect?.status === "succeeded"
          ? "done"
          : effect?.status === "failed"
            ? "failed"
            : stepStatus(node);
      const recovered = effect?.status === "succeeded" && node.status === "failed";
      return {
        key: node.key,
        label: node.label,
        status,
        ...(recovered
          ? { detail: "Recovered by retry" }
          : node.detail
            ? { detail: node.detail }
            : {}),
      };
    });
    const retryable =
      outcome?.status === "published" && access.publish
        ? effects
            .filter((effect) => effect.status === "failed" || effect.status === "unknown")
            .map((effect) => effect.effect)
        : [];
    const failedEffect = effects.find(
      (effect) => effect.status === "failed" || effect.status === "unknown",
    );
    return {
      snapshotId: snapshot.id,
      revisionNumber: snapshot.revisionNumber,
      visibility: snapshot.visibility,
      sensitivity: snapshot.sensitivity,
      createdAt: snapshot.createdAt,
      createdBy: this.person(snapshot.createdBy),
      state,
      steps,
      conflict:
        outcome?.status === "conflict"
          ? {
              reason: outcome.reason,
              expected: outcome.expectedLifecycleVersion,
              actual: outcome.actualLifecycleVersion,
            }
          : null,
      failure: failedEffect
        ? {
            code: failedEffect.lastErrorCode ?? "effect_failed",
            message: effectFailureMessage(failedEffect.lastErrorCode),
          }
        : state === "published" || state === "conflict"
          ? null
          : run?.failure
            ? { code: run.failure.code, message: run.failure.message }
            : state === "failed_before_publish"
              ? {
                  code: "workflow_not_started",
                  message: "The publication workflow could not be started.",
                }
              : null,
      effects: effects.map((effect) => ({
        effect: effect.effect,
        status: effect.status,
        attempts: effect.attempts,
        lastErrorCode: effect.lastErrorCode,
      })),
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      approvalUrl:
        run?.approvals.find((task) => task.status === "pending")?.url ??
        run?.approvals.at(-1)?.url ??
        null,
      canCancel:
        state === "waiting_approval" &&
        (snapshot.createdBy === this.me.id || roleIn(this.context, snapshot.spaceId) === "owner"),
      retryableEffects: retryable,
    };
  }

  // ---------------------------------------------------------------------------
  // Page Edit / draft / publish
  // ---------------------------------------------------------------------------

  async editView(spaceKey: string, pageId: string): ServiceResult<EditView> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    const { space, page, access } = loaded.value;
    if (!access.readDraft) return Result.fail(notFound());
    if (!access.edit) {
      return Result.fail(
        page.status === "archived"
          ? new KnowledgeServiceError("invalid_state", "Archived pages cannot be edited")
          : forbidden(),
      );
    }
    const draft = await fromStore(this.repos.pages.findDraft(page.id));
    if (Result.isFailure(draft)) return draft;
    if (!draft.value) return Result.fail(notFound());
    const published = page.publishedRevisionId
      ? await fromStore(this.repos.revisions.find(page.publishedRevisionId))
      : Result.succeed(null);
    if (Result.isFailure(published)) return published;
    return Result.succeed({
      space: { id: space.id, key: space.key, name: space.name },
      pageId: page.id,
      status: page.status,
      draft: draftView(draft.value),
      publishedRevisionNumber: published.value?.number ?? null,
      hasUnpublishedChanges: hasUnpublishedChanges(draft.value, page, published.value),
      canPublish: access.publish,
    });
  }

  /** Draft save touches Knowledge D1 only: no ActionRequest, no approval. */
  async saveDraft(
    spaceKey: string,
    pageId: string,
    body: unknown,
  ): ServiceResult<EditView["draft"]> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value.access.edit) return Result.fail(forbidden());
    const input = saveDraftInputSchema.safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const saved = await fromStore(
      this.repos.pages.saveDraft({
        pageId,
        draft: input.data,
        principalId: this.me.id,
        now: this.now(),
      }),
    );
    if (Result.isFailure(saved)) return saved;
    return Result.succeed(draftView(saved.value));
  }

  /**
   * Publish: immutable Revision (or reuse of an identical one) + immutable
   * PublicationSnapshot, then `knowledge.publish_document` in ultra-easy.
   * Whether approval is needed is decided by ultra-easy, not here.
   */
  async publish(
    spaceKey: string,
    pageId: string,
    body: unknown,
  ): ServiceResult<{ snapshotId: string; revisionNumber: number; runStatus: string | null }> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    const { space, page, access } = loaded.value;
    const input = publishInputSchema.safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const draft = await fromStore(this.repos.pages.findDraft(page.id));
    if (Result.isFailure(draft)) return draft;
    if (!draft.value) return Result.fail(notFound());
    if (draft.value.version !== input.data.expectedDraftVersion) {
      return Result.fail(
        new KnowledgeServiceError(
          "draft_conflict",
          "The draft changed since you opened it",
          "Save or reload before publishing.",
        ),
      );
    }
    const latest = await fromStore(this.repos.revisions.latest(page.id));
    if (Result.isFailure(latest)) return latest;
    const now = this.now();
    const reuse = latest.value && sameContent(draft.value, latest.value) ? latest.value : null;
    const revision: Revision | null = reuse
      ? null
      : {
          id: newId("rev"),
          pageId: page.id,
          number: (latest.value?.number ?? 0) + 1,
          title: draft.value.title,
          body: draft.value.body,
          tags: draft.value.tags,
          createdBy: this.me.id,
          createdAt: now,
        };
    const pinned = reuse ?? revision;
    if (!pinned) return Result.fail(notFound());
    const valid = validatePublicationSnapshot({
      access,
      page,
      revision: pinned,
      spaceId: space.id,
      visibility: draft.value.visibility,
      sensitivity: draft.value.sensitivity,
      expectedLifecycleVersion: page.lifecycleVersion,
    });
    if (Result.isFailure(valid)) {
      return Result.fail(
        valid.error.code === "forbidden"
          ? forbidden()
          : new KnowledgeServiceError(
              "publication_invalid",
              "This page cannot be published right now",
              valid.error.message,
            ),
      );
    }
    const snapshot: PublicationSnapshot = {
      id: newId("pub"),
      pageId: page.id,
      revisionId: pinned.id,
      revisionNumber: pinned.number,
      spaceId: space.id,
      visibility: draft.value.visibility,
      sensitivity: draft.value.sensitivity,
      expectedLifecycleVersion: page.lifecycleVersion,
      createdBy: this.me.id,
      createdAt: now,
    };
    const written = await fromStore(this.repos.revisions.insertPublication({ revision, snapshot }));
    if (Result.isFailure(written)) return written;

    const started = await fromPlatform(
      this.ultraEasy.startAction({
        organizationId: this.organizationId,
        actor: this.me,
        actionType: "knowledge.publish_document",
        resource: { type: "knowledge_page", id: page.id },
        input: { publicationSnapshotId: snapshot.id },
        correlation: { spaceId: space.id, pageId: page.id, publicationSnapshotId: snapshot.id },
        idempotencyKey: `publish:${snapshot.id}`,
      }),
    );
    if (Result.isFailure(started)) return started;
    const attached = await fromStore(
      this.repos.revisions.attachRequest({
        publicationSnapshotId: snapshot.id,
        actionRequestId: started.value.actionRequestId,
        workflowRunId: started.value.run.id,
        createdAt: now,
      }),
    );
    if (Result.isFailure(attached)) return attached;
    return Result.succeed({
      snapshotId: snapshot.id,
      revisionNumber: snapshot.revisionNumber,
      runStatus: started.value.run.status,
    });
  }

  async cancelPublication(snapshotId: string): ServiceResult<{ status: string }> {
    const target = await this.snapshotForAuthor(snapshotId);
    if (Result.isFailure(target)) return target;
    const request = await fromStore(this.repos.revisions.findRequest(snapshotId));
    if (Result.isFailure(request)) return request;
    if (!request.value) return Result.fail(notFound());
    const cancelled = await fromPlatform(
      this.ultraEasy.cancelAction({
        organizationId: this.organizationId,
        actionRequestId: request.value.actionRequestId,
        actor: this.me,
      }),
    );
    if (Result.isFailure(cancelled)) return cancelled;
    return Result.succeed({ status: cancelled.value.status });
  }

  /** Snapshot the caller may govern (publish capability on its page). */
  private async snapshotForAuthor(
    snapshotId: string,
  ): ServiceResult<{ snapshot: PublicationSnapshot; page: Page }> {
    const snapshot = await fromStore(this.repos.revisions.findSnapshot(snapshotId));
    if (Result.isFailure(snapshot)) return snapshot;
    if (!snapshot.value) return Result.fail(notFound());
    const page = await fromStore(this.repos.pages.find(snapshot.value.pageId));
    if (Result.isFailure(page)) return page;
    if (!page.value) return Result.fail(notFound());
    const access = pageAccess(this.context, page.value);
    if (!canSeePage(access)) return Result.fail(notFound());
    if (!hasSpaceCapability(this.context, page.value.spaceId, "knowledge.page.publish")) {
      return Result.fail(forbidden());
    }
    return Result.succeed({ snapshot: snapshot.value, page: page.value });
  }

  /**
   * Recovery: a new, separate ActionRequest for one failed post-publish effect.
   * The successful publication itself is never re-executed.
   */
  async retryEffect(snapshotId: string, effect: string): ServiceResult<{ status: string }> {
    if (effect !== "search_reindex" && effect !== "watcher_notification") {
      return Result.fail(new KnowledgeServiceError("validation_error", "Unknown effect"));
    }
    const target = await this.snapshotForAuthor(snapshotId);
    if (Result.isFailure(target)) return target;
    const outcome = await fromStore(this.repos.revisions.findOutcome(snapshotId));
    if (Result.isFailure(outcome)) return outcome;
    if (outcome.value?.status !== "published") {
      return Result.fail(
        new KnowledgeServiceError(
          "invalid_state",
          "Only published snapshots have effects to retry",
        ),
      );
    }
    const effects = await fromStore(this.repos.effects.list(snapshotId));
    if (Result.isFailure(effects)) return effects;
    const current = effects.value.find((entry) => entry.effect === effect);
    if (!current || (current.status !== "failed" && current.status !== "unknown")) {
      return Result.fail(new KnowledgeServiceError("invalid_state", "This effect has not failed"));
    }
    const started = await fromPlatform(
      this.ultraEasy.startAction({
        organizationId: this.organizationId,
        actor: this.me,
        actionType:
          effect === "search_reindex" ? "knowledge.search.reindex" : "knowledge.watchers.notify",
        resource: { type: "knowledge_page", id: target.value.page.id },
        input: { publicationSnapshotId: snapshotId },
        correlation: {
          spaceId: target.value.page.spaceId,
          pageId: target.value.page.id,
          publicationSnapshotId: snapshotId,
        },
        idempotencyKey: `retry:${snapshotId}:${effect}:${current.attempts}`,
      }),
    );
    if (Result.isFailure(started)) return started;
    return Result.succeed({ status: started.value.run.status });
  }

  async archive(
    spaceKey: string,
    pageId: string,
  ): ServiceResult<{ status: string; approvalUrl: string | null }> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    const { page, access } = loaded.value;
    if (!access.archive) return Result.fail(forbidden());
    const started = await fromPlatform(
      this.ultraEasy.startAction({
        organizationId: this.organizationId,
        actor: this.me,
        actionType: "knowledge.page.archive",
        resource: { type: "knowledge_page", id: page.id },
        input: { pageId: page.id, pageOwnerId: page.ownerId },
        correlation: { spaceId: page.spaceId, pageId: page.id },
        idempotencyKey: `archive:${page.id}:${page.lifecycleVersion}:${this.me.id}`,
      }),
    );
    if (Result.isFailure(started)) return started;
    return Result.succeed({
      status: started.value.run.status,
      approvalUrl:
        started.value.run.approvals.find((task) => task.status === "pending")?.url ?? null,
    });
  }

  async restore(spaceKey: string, pageId: string): ServiceResult<{ status: string }> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value.access.restore) return Result.fail(forbidden());
    const restored = await fromStore(this.repos.pages.restore(pageId, this.now()));
    if (Result.isFailure(restored)) return restored;
    return Result.succeed({ status: restored.value?.page.status ?? "active" });
  }

  async setWatching(
    spaceKey: string,
    pageId: string,
    body: unknown,
  ): ServiceResult<{ watching: boolean }> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value.access.watch) return Result.fail(forbidden());
    const input = z.object({ watching: z.boolean() }).safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const changed = await fromStore(
      this.repos.pages.setWatching({
        pageId,
        principalId: this.me.id,
        watching: input.data.watching,
        now: this.now(),
      }),
    );
    if (Result.isFailure(changed)) return changed;
    return Result.succeed({ watching: input.data.watching });
  }

  // ---------------------------------------------------------------------------
  // Revision history (read_history)
  // ---------------------------------------------------------------------------

  async revisions(spaceKey: string, pageId: string): ServiceResult<RevisionSummaryView[]> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value.access.readHistory) return Result.fail(notFound());
    const [revisions, snapshots, outcomes] = await Promise.all([
      fromStore(this.repos.revisions.list(pageId)),
      fromStore(this.repos.revisions.snapshotsForPage(pageId)),
      fromStore(this.repos.revisions.outcomesForPage(pageId)),
    ]);
    if (Result.isFailure(revisions)) return revisions;
    if (Result.isFailure(snapshots)) return snapshots;
    if (Result.isFailure(outcomes)) return outcomes;
    const outcomeOf = new Map(
      outcomes.value.map((outcome) => [outcome.snapshotId, outcome.status]),
    );
    return Result.succeed(
      revisions.value.map((revision) => ({
        number: revision.number,
        title: revision.title,
        createdAt: revision.createdAt,
        createdBy: this.person(revision.createdBy),
        current: revision.id === loaded.value.page.publishedRevisionId,
        publications: snapshots.value
          .filter((snapshot) => snapshot.revisionId === revision.id)
          .map((snapshot) => ({
            snapshotId: snapshot.id,
            visibility: snapshot.visibility,
            sensitivity: snapshot.sensitivity,
            outcome: outcomeOf.get(snapshot.id) ?? "pending",
          })),
      })),
    );
  }

  async revision(
    spaceKey: string,
    pageId: string,
    number: number,
  ): ServiceResult<RevisionDetailView> {
    const loaded = await this.loadPage(spaceKey, pageId);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value.access.readHistory) return Result.fail(notFound());
    const revision = await fromStore(this.repos.revisions.findByNumber(pageId, number));
    if (Result.isFailure(revision)) return revision;
    if (!revision.value) return Result.fail(notFound());
    return Result.succeed({
      number: revision.value.number,
      title: revision.value.title,
      body: revision.value.body,
      tags: revision.value.tags,
      createdAt: revision.value.createdAt,
      createdBy: this.person(revision.value.createdBy),
    });
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(query: Record<string, string | undefined>): ServiceResult<SearchView> {
    const input = searchInputSchema.safeParse(query);
    if (!input.success) return Result.fail(validation(input.error));
    const scope = this.scope();
    const spaces = await fromStore(
      this.repos.spaces.listByIds(this.organizationId, scope.memberSpaceIds),
    );
    if (Result.isFailure(spaces)) return spaces;
    const tags = await fromStore(this.repos.search.tags({ scope }));
    if (Result.isFailure(tags)) return tags;
    const base = {
      query: input.data.q,
      spaces: spaces.value.map((space) => ({ key: space.key, name: space.name })),
      tags: tags.value,
    };
    if (input.data.q.length === 0) return Result.succeed({ ...base, results: [] });
    const match = ftsMatchExpression(input.data.q);
    if (Result.isFailure(match)) {
      return Result.fail(new KnowledgeServiceError("validation_error", match.error.message));
    }
    // Space filter only resolves spaces the caller is a member of.
    const spaceId = input.data.space
      ? spaces.value.find((space) => space.key === input.data.space)?.id
      : undefined;
    if (input.data.space && !spaceId) return Result.succeed({ ...base, results: [] });

    const [published, authoring] = await Promise.all([
      fromStore(
        this.repos.search.searchPublished({
          scope,
          match: match.value,
          spaceId,
          tag: input.data.tag,
          limit: 50,
        }),
      ),
      fromStore(
        this.repos.search.searchAuthoring({
          scope,
          match: match.value,
          spaceId,
          tag: input.data.tag,
          limit: 50,
        }),
      ),
    ]);
    if (Result.isFailure(published)) return published;
    if (Result.isFailure(authoring)) return authoring;
    const results: SearchResultView[] = authoring.value.map((hit) => ({
      pageId: hit.pageId,
      spaceKey: hit.spaceKey,
      spaceName: hit.spaceName,
      title: hit.title,
      snippet: plainSnippet(hit.snippet),
      tags: hit.tags,
      badge: authoringBadge(hit),
      timestamp: hit.updatedAt,
    }));
    const seen = new Set(results.map((result) => result.pageId));
    for (const hit of published.value) {
      if (seen.has(hit.pageId)) continue;
      // Authoring readers see the authoring projection of their spaces only.
      if (scope.authoringSpaceIds.includes(hit.spaceId)) continue;
      results.push({
        pageId: hit.pageId,
        spaceKey: hit.spaceKey,
        spaceName: hit.spaceName,
        title: hit.title,
        snippet: plainSnippet(hit.snippet),
        tags: hit.tags,
        badge: "published",
        timestamp: hit.publishedAt,
      });
    }
    return Result.succeed({ ...base, results: results.slice(0, 50) });
  }

  // ---------------------------------------------------------------------------
  // Automation
  // ---------------------------------------------------------------------------

  private async visibleRuns(): ServiceResult<
    Array<{ run: WorkflowRunView; item: AutomationItemView }>
  > {
    const scope = this.scope();
    const runs = await fromPlatform(
      this.ultraEasy.listRuns({
        organizationId: this.organizationId,
        spaceIds: scope.memberSpaceIds,
        limit: 100,
      }),
    );
    if (Result.isFailure(runs)) return runs;
    const spaces = await fromStore(
      this.repos.spaces.listByIds(this.organizationId, scope.memberSpaceIds),
    );
    if (Result.isFailure(spaces)) return spaces;
    const spaceOf = new Map(spaces.value.map((space) => [space.id, space]));
    const visible: Array<{ run: WorkflowRunView; item: AutomationItemView }> = [];
    for (const run of runs.value) {
      const space = spaceOf.get(run.correlation.spaceId);
      if (!space) continue;
      const item = await this.automationItem(run, space);
      if (item) visible.push({ run, item });
    }
    return Result.succeed(visible);
  }

  /** Null when the caller may not see this run's Knowledge resources. */
  private async automationItem(
    run: WorkflowRunView,
    space: Space,
  ): Promise<AutomationItemView | null> {
    const assignedToMe = run.humanInputs.some((input) => input.assigneeId === this.me.id);
    let page: { id: string; title: string } | null = null;
    if (run.correlation.pageId) {
      const found = await this.repos.pages.find(run.correlation.pageId);
      if (Result.isFailure(found) || !found.value) return null;
      const access = pageAccess(this.context, found.value);
      if (!access.readDraft && run.requestedBy.id !== this.me.id) return null;
      page = { id: found.value.id, title: await this.titleOf(found.value, access) };
    } else if (
      !hasSpaceCapability(this.context, space.id, "knowledge.page.read_draft") &&
      !assignedToMe
    ) {
      return null;
    }

    let recovered = false;
    if (run.correlation.publicationSnapshotId && run.status === "failed") {
      const effects = await this.repos.effects.list(run.correlation.publicationSnapshotId);
      const outcome = await this.repos.revisions.findOutcome(run.correlation.publicationSnapshotId);
      recovered =
        Result.isSuccess(effects) &&
        Result.isSuccess(outcome) &&
        outcome.value?.status === "published" &&
        effects.value.every((effect) => effect.status === "succeeded");
    }

    const kind: AutomationItemView["kind"] =
      run.actionType === "knowledge.publish_document"
        ? "publish_document"
        : run.actionType === "knowledge.maintain_space"
          ? "maintain_space"
          : run.actionType === "knowledge.page.archive"
            ? "archive"
            : "recovery";
    const pageTitle = page?.title ?? "";
    const label =
      kind === "publish_document"
        ? `Publishing "${pageTitle}"`
        : kind === "maintain_space"
          ? `Stale document review - ${space.name}`
          : kind === "archive"
            ? `Archiving "${pageTitle}"`
            : `${run.actionType === "knowledge.search.reindex" ? "Search reindex" : "Watcher notification"} retry for "${pageTitle}"`;

    const waitingForMe = run.humanInputs.some(
      (input) => input.status === "waiting" && input.assigneeId === this.me.id,
    );
    let category: AutomationCategory;
    if (run.status === "failed" && !recovered) category = "needs_attention";
    else if (waitingForMe) category = "needs_attention";
    else if (run.status === "waiting_approval" || run.status === "waiting_input")
      category = "waiting";
    else if (run.status === "running") category = "running";
    else category = "completed";

    const failureCode = run.failure?.code ?? null;
    const statusLabel = recovered
      ? "Recovered"
      : run.status === "failed"
        ? failureCode === "publication_conflict"
          ? "Publication conflict"
          : run.failure?.nodeKey === "notify"
            ? "Notification failed"
            : run.failure?.nodeKey === "reindex"
              ? "Search index failed"
              : "Failed"
        : STATUS_LABEL[run.status];
    const nextAction = waitingForMe
      ? "Answer review"
      : run.status === "waiting_approval"
        ? "View approval"
        : run.status === "failed" && !recovered
          ? failureCode === "publication_conflict"
            ? "Open page"
            : run.failure?.nodeKey === "notify"
              ? "Retry notification"
              : run.failure?.nodeKey === "reindex"
                ? "Retry search index"
                : "Open page"
          : null;
    return {
      runId: run.id,
      actionRequestId: run.actionRequestId,
      kind,
      label,
      space: { key: space.key, name: space.name },
      page,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      status: recovered ? "recovered" : run.status,
      statusLabel,
      category,
      nextAction,
    };
  }

  async automation(): ServiceResult<AutomationView> {
    const runs = await this.visibleRuns();
    if (Result.isFailure(runs)) return runs;
    const spaces = await fromStore(
      this.repos.spaces.listByIds(this.organizationId, this.scope().memberSpaceIds),
    );
    if (Result.isFailure(spaces)) return spaces;
    return Result.succeed({
      items: runs.value.map((entry) => entry.item),
      spaces: spaces.value
        .filter((space) => hasSpaceCapability(this.context, space.id, "knowledge.space.administer"))
        .map((space) => ({ key: space.key, name: space.name })),
    });
  }

  async automationDetail(runId: string): ServiceResult<AutomationDetailView> {
    const run = await fromPlatform(
      this.ultraEasy.getRun({ organizationId: this.organizationId, runId }),
    );
    if (Result.isFailure(run)) return run;
    if (!run.value) return Result.fail(notFound());
    // Knowing a run ID is not enough: the caller must see its Knowledge resources.
    const space = await fromStore(this.repos.spaces.findById(run.value.correlation.spaceId));
    if (Result.isFailure(space)) return space;
    if (!space.value || !roleIn(this.context, space.value.id)) return Result.fail(notFound());
    const item = await this.automationItem(run.value, space.value);
    if (!item) return Result.fail(notFound());

    let publication: AutomationDetailView["publication"] = null;
    let retryableEffects: AutomationDetailView["retryableEffects"] = [];
    let steps = run.value.nodes.map((node) => ({
      key: node.key,
      label: node.label,
      status: stepStatus(node),
      ...(node.detail ? { detail: node.detail } : {}),
    }));
    const snapshotId = run.value.correlation.publicationSnapshotId;
    if (snapshotId && run.value.correlation.pageId) {
      const snapshot = await fromStore(this.repos.revisions.findSnapshot(snapshotId));
      if (Result.isFailure(snapshot)) return snapshot;
      const page = await fromStore(this.repos.pages.find(run.value.correlation.pageId));
      if (Result.isFailure(page)) return page;
      if (snapshot.value && page.value) {
        const access = pageAccess(this.context, page.value);
        publication = {
          snapshotId: snapshot.value.id,
          revisionNumber: snapshot.value.revisionNumber,
          visibility: snapshot.value.visibility,
          sensitivity: snapshot.value.sensitivity,
          createdBy: this.person(snapshot.value.createdBy),
          createdAt: snapshot.value.createdAt,
        };
        const [effects, outcome] = await Promise.all([
          fromStore(this.repos.effects.list(snapshotId)),
          fromStore(this.repos.revisions.findOutcome(snapshotId)),
        ]);
        if (Result.isFailure(effects)) return effects;
        if (Result.isFailure(outcome)) return outcome;
        if (run.value.actionType === "knowledge.publish_document") {
          steps = this.panel({
            snapshot: snapshot.value,
            outcome: outcome.value,
            effects: effects.value,
            run: run.value,
            access,
          }).steps;
        }
        retryableEffects =
          outcome.value?.status === "published" && access.publish
            ? effects.value
                .filter((effect) => effect.status === "failed" || effect.status === "unknown")
                .map((effect) => effect.effect)
            : [];
      }
    }

    const spaceKeys = await this.spaceKeys();
    return Result.succeed({
      ...item,
      steps,
      approvals: run.value.approvals.map((task) => ({
        taskId: task.taskId,
        actionType: task.actionType,
        status: task.status,
        url: task.url,
      })),
      humanInputs: run.value.humanInputs.map((input) => ({
        key: input.key,
        pageId: input.subject.pageId,
        spaceKey: spaceKeys.get(run.value?.correlation.spaceId ?? "") ?? "",
        title: input.subject.title,
        prompt: input.prompt,
        analysis: input.analysis,
        status: input.status,
        answer: input.answer ?? null,
        canRespond: input.status === "waiting" && input.assigneeId === this.me.id,
        assignee: this.person(input.assigneeId),
      })),
      childActions: run.value.childActions.map((child) => ({
        actionRequestId: child.actionRequestId,
        actionType: child.actionType,
        status: child.status,
        errorCode: child.errorCode ?? null,
      })),
      failure: run.value.failure
        ? { code: run.value.failure.code, message: run.value.failure.message }
        : null,
      publication,
      retryableEffects,
      audit: run.value.audit,
    });
  }

  /** Knowledge-domain Human Input (not an approval decision). */
  async submitHumanInput(
    runId: string,
    inputKey: string,
    body: unknown,
  ): ServiceResult<{ status: string }> {
    const input = z.object({ answer: z.enum(HUMAN_REVIEW_DECISIONS) }).safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const detail = await this.automationDetail(runId);
    if (Result.isFailure(detail)) return detail;
    const request = detail.value.humanInputs.find((entry) => entry.key === inputKey);
    if (!request) return Result.fail(notFound());
    if (!request.canRespond)
      return Result.fail(forbidden("This review is assigned to someone else"));
    const submitted = await fromPlatform(
      this.ultraEasy.submitHumanInput({
        organizationId: this.organizationId,
        runId,
        inputKey,
        answer: input.data.answer,
        actor: this.me,
      }),
    );
    if (Result.isFailure(submitted)) return submitted;
    return Result.succeed({ status: submitted.value.status });
  }

  /** Manual trigger of `knowledge.maintain_space` (the weekly Cron Trigger shares the start path, #184). */
  async runMaintenance(spaceKey: string): ServiceResult<{ runId: string; status: string }> {
    const loaded = await this.loadSpace(spaceKey);
    if (Result.isFailure(loaded)) return loaded;
    const { space } = loaded.value;
    if (!hasSpaceCapability(this.context, space.id, "knowledge.space.administer"))
      return Result.fail(forbidden());
    const started = await fromPlatform(
      startSpaceMaintenance({
        ultraEasy: this.ultraEasy,
        organizationId: this.organizationId,
        spaceId: space.id,
        actor: this.me,
        idempotencyKey: manualMaintenanceKey(space.id),
      }),
    );
    if (Result.isFailure(started)) return started;
    return Result.succeed({ runId: started.value.runId, status: started.value.status });
  }

  // ---------------------------------------------------------------------------
  // Space Settings (post-MVP screen 8): domain presets -> governed policy update
  // ---------------------------------------------------------------------------

  async settings(spaceKey: string): ServiceResult<SpaceSettingsView> {
    const loaded = await this.loadSpace(spaceKey);
    if (Result.isFailure(loaded)) return loaded;
    const { space, summary } = loaded.value;
    if (!hasSpaceCapability(this.context, space.id, "knowledge.space.administer"))
      return Result.fail(notFound());
    const [binding, members] = await Promise.all([
      fromPlatform(
        this.ultraEasy.getPolicyBinding({ organizationId: this.organizationId, spaceId: space.id }),
      ),
      fromPlatform(
        this.ultraEasy.spaceMembers({ organizationId: this.organizationId, spaceId: space.id }),
      ),
    ]);
    if (Result.isFailure(binding)) return binding;
    if (Result.isFailure(members)) return members;
    return Result.succeed({
      space: summary,
      rules: decompileApprovalRules(binding.value.policy),
      policyVersion: binding.value.version,
      pendingChange: binding.value.pendingChange
        ? {
            approvalUrl: binding.value.pendingChange.approvalUrl,
            rules: decompileApprovalRules(binding.value.pendingChange.policy),
          }
        : null,
      members: members.value,
      adminUrl: this.ultraEasy.adminPolicyUrl(space.id),
    });
  }

  async saveSettings(spaceKey: string, body: unknown): ServiceResult<SpaceSettingsView> {
    const loaded = await this.loadSpace(spaceKey);
    if (Result.isFailure(loaded)) return loaded;
    const { space } = loaded.value;
    if (!hasSpaceCapability(this.context, space.id, "knowledge.space.administer"))
      return Result.fail(notFound());
    const input = approvalRulesInputSchema.safeParse(body);
    if (!input.success) return Result.fail(validation(input.error));
    const proposed = await fromPlatform(
      this.ultraEasy.proposePolicyBinding({
        organizationId: this.organizationId,
        spaceId: space.id,
        policy: compileApprovalRules(input.data.rules),
        actor: this.me,
      }),
    );
    if (Result.isFailure(proposed)) return proposed;
    return this.settings(spaceKey);
  }
}

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  waiting_approval: "Waiting for approval",
  waiting_input: "Waiting for input",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

function effectFailureMessage(code: string | null): string {
  switch (code) {
    case "notifier_unavailable":
      return "Downstream notification temporarily unavailable";
    case "search_index_unavailable":
      return "Search index temporarily unavailable";
    default:
      return "A post-publish effect failed";
  }
}

function authoringBadge(row: {
  publishedRevisionId: string | null;
  reviewState: string;
  title: string;
  body: string;
  tags: string[];
  visibility: string;
  sensitivity: string;
  publishedTitle: string | null;
  publishedBody: string | null;
  publishedTags: string[] | null;
  publishedVisibility: string | null;
  publishedSensitivity: string | null;
}): PageBadge {
  if (row.publishedRevisionId === null) return "draft";
  if (row.reviewState === "update_needed") return "needs_review";
  const changed =
    !sameContent(row, {
      title: row.publishedTitle ?? "",
      body: row.publishedBody ?? "",
      tags: row.publishedTags ?? [],
    }) ||
    row.visibility !== row.publishedVisibility ||
    row.sensitivity !== row.publishedSensitivity;
  return changed ? "draft_changes" : "published";
}

function draftView(draft: Draft): EditView["draft"] {
  return {
    title: draft.title,
    body: draft.body,
    tags: draft.tags,
    visibility: draft.visibility,
    sensitivity: draft.sensitivity,
    version: draft.version,
    updatedAt: draft.updatedAt,
  };
}
