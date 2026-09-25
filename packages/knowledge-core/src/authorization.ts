import type { KnowledgeContext, Page, SpaceRole } from "./model.ts";

/**
 * Capabilities the Knowledge app checks for normal reads / edits. Governed side
 * effects (publish commit, archive) are additionally authorized by ultra-easy
 * through ActionRequests; these checks only decide what the caller may see or
 * start.
 */
export const KNOWLEDGE_CAPABILITIES = [
  "knowledge.page.read_published",
  "knowledge.page.read_draft",
  "knowledge.page.read_history",
  "knowledge.page.create",
  "knowledge.page.edit",
  "knowledge.page.publish",
  "knowledge.page.archive",
  "knowledge.page.restore",
  "knowledge.space.administer",
] as const;
export type KnowledgeCapability = (typeof KNOWLEDGE_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<SpaceRole, readonly KnowledgeCapability[]> = {
  viewer: ["knowledge.page.read_published"],
  editor: [
    "knowledge.page.read_published",
    "knowledge.page.read_draft",
    "knowledge.page.create",
    "knowledge.page.edit",
    "knowledge.page.publish",
  ],
  owner: KNOWLEDGE_CAPABILITIES,
};

export function capabilitiesForRole(role: SpaceRole | null): ReadonlySet<KnowledgeCapability> {
  return new Set(role ? ROLE_CAPABILITIES[role] : []);
}

export function roleIn(context: KnowledgeContext, spaceId: string): SpaceRole | null {
  return context.spaceRoles.get(spaceId) ?? null;
}

export function hasSpaceCapability(
  context: KnowledgeContext,
  spaceId: string,
  capability: KnowledgeCapability,
): boolean {
  return capabilitiesForRole(roleIn(context, spaceId)).has(capability);
}

/**
 * Whether the caller may read the page's *current published revision*.
 * - organization: every principal of the organization
 * - space: any role in the page's space
 * - private: the page owner or a space owner
 */
export function canReadPublished(
  context: KnowledgeContext,
  page: Pick<Page, "spaceId" | "ownerId" | "publishedRevisionId" | "publishedVisibility">,
): boolean {
  if (page.publishedRevisionId === null || page.publishedVisibility === null) return false;
  const role = roleIn(context, page.spaceId);
  switch (page.publishedVisibility) {
    case "organization":
      return true;
    case "space":
      return role !== null;
    case "private":
      return page.ownerId === context.principal.id || role === "owner";
  }
}

export type PageAccess = {
  readPublished: boolean;
  readDraft: boolean;
  readHistory: boolean;
  edit: boolean;
  publish: boolean;
  archive: boolean;
  restore: boolean;
  watch: boolean;
};

/** The single place that decides what a caller may do with one page. */
export function pageAccess(
  context: KnowledgeContext,
  page: Pick<
    Page,
    "spaceId" | "ownerId" | "status" | "publishedRevisionId" | "publishedVisibility"
  >,
): PageAccess {
  const capabilities = capabilitiesForRole(roleIn(context, page.spaceId));
  const active = page.status === "active";
  const readPublished = canReadPublished(context, page);
  const readDraft = capabilities.has("knowledge.page.read_draft");
  return {
    readPublished,
    readDraft,
    readHistory: capabilities.has("knowledge.page.read_history"),
    edit: active && capabilities.has("knowledge.page.edit"),
    publish: active && capabilities.has("knowledge.page.publish"),
    archive: active && capabilities.has("knowledge.page.archive"),
    restore: !active && capabilities.has("knowledge.page.restore"),
    watch: readPublished || readDraft,
  };
}

/** A page is visible at all only if some projection of it is readable. */
export function canSeePage(access: PageAccess): boolean {
  return access.readPublished || access.readDraft;
}

/**
 * Scope the search / listing queries run with. It is decided *before* querying
 * so unauthorized rows never leave the database (no fetch-then-filter).
 */
export type ReadScope = {
  organizationId: string;
  principalId: string;
  /** spaces where `space` visibility published pages are readable */
  memberSpaceIds: string[];
  /** spaces where `private` published pages are readable (space owner) */
  ownerSpaceIds: string[];
  /** spaces whose drafts (authoring content) are readable */
  authoringSpaceIds: string[];
};

export function readScope(context: KnowledgeContext): ReadScope {
  const memberSpaceIds: string[] = [];
  const ownerSpaceIds: string[] = [];
  const authoringSpaceIds: string[] = [];
  for (const [spaceId, role] of context.spaceRoles) {
    memberSpaceIds.push(spaceId);
    if (role === "owner") ownerSpaceIds.push(spaceId);
    if (capabilitiesForRole(role).has("knowledge.page.read_draft")) authoringSpaceIds.push(spaceId);
  }
  return {
    organizationId: context.organizationId,
    principalId: context.principal.id,
    memberSpaceIds: memberSpaceIds.sort(),
    ownerSpaceIds: ownerSpaceIds.sort(),
    authoringSpaceIds: authoringSpaceIds.sort(),
  };
}
