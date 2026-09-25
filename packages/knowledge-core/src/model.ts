import { z } from "zod";

/**
 * Knowledge Workspace domain model (#167).
 *
 * The Knowledge app owns every type here. ultra-easy Workflow / Approval types
 * never leak in: Knowledge only keeps correlation IDs (ActionRequest /
 * WorkflowRun) next to its own records.
 */

export const VISIBILITIES = ["private", "space", "organization"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const SENSITIVITIES = ["normal", "internal", "confidential"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const SPACE_ROLES = ["viewer", "editor", "owner"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export type PageStatus = "active" | "archived";

/** Knowledge-domain review state set by the maintenance workflow. */
export type ReviewState = "current" | "update_needed";

export type Principal = { id: string; displayName: string };

/**
 * Trusted caller context. Built server-side from the session and the
 * authorization provider; never from browser input.
 */
export type KnowledgeContext = {
  organizationId: string;
  principal: Principal;
  /** spaceId -> role. A space missing here means no role. */
  spaceRoles: ReadonlyMap<string, SpaceRole>;
};

export type Space = {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
};

export type Page = {
  id: string;
  spaceId: string;
  ownerId: string;
  status: PageStatus;
  /** Bumped by externally visible lifecycle transitions only (publish / archive / restore). */
  lifecycleVersion: number;
  publishedRevisionId: string | null;
  publishedSnapshotId: string | null;
  publishedVisibility: Visibility | null;
  publishedSensitivity: Sensitivity | null;
  publishedAt: string | null;
  publishedBy: string | null;
  reviewState: ReviewState;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Mutable authoring state. Saving it never creates an ActionRequest. */
export type Draft = {
  pageId: string;
  title: string;
  body: string;
  tags: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
  /** Optimistic concurrency for editors (independent of lifecycleVersion). */
  version: number;
  updatedBy: string;
  updatedAt: string;
};

/** INSERT-only content snapshot. */
export type Revision = {
  id: string;
  pageId: string;
  number: number;
  title: string;
  body: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
};

/**
 * INSERT-only business snapshot the publication approval is about: the exact
 * revision plus the publication settings and the lifecycle version it expects.
 */
export type PublicationSnapshot = {
  id: string;
  pageId: string;
  revisionId: string;
  revisionNumber: number;
  spaceId: string;
  visibility: Visibility;
  sensitivity: Sensitivity;
  expectedLifecycleVersion: number;
  createdBy: string;
  createdAt: string;
};

export type PublicationOutcome =
  | { snapshotId: string; status: "published"; recordedAt: string }
  | {
      snapshotId: string;
      status: "conflict";
      reason: "lifecycle_mismatch" | "archived";
      expectedLifecycleVersion: number;
      actualLifecycleVersion: number;
      recordedAt: string;
    };

export const PUBLICATION_EFFECTS = ["search_reindex", "watcher_notification"] as const;
export type PublicationEffectKind = (typeof PUBLICATION_EFFECTS)[number];

export type PublicationEffectStatus = "pending" | "succeeded" | "failed" | "unknown";

export type PublicationEffect = {
  publicationSnapshotId: string;
  effect: PublicationEffectKind;
  status: PublicationEffectStatus;
  attempts: number;
  lastErrorCode: string | null;
  updatedAt: string;
};

/** Correlation between a snapshot and the ultra-easy request that governs it. */
export type PublicationRequest = {
  publicationSnapshotId: string;
  actionRequestId: string;
  workflowRunId: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Input schemas (browser input is untrusted; the server validates everything)
// ---------------------------------------------------------------------------

export const spaceKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, "Use 2-32 lowercase letters, digits or hyphens");

export const pageIdSchema = z.string().regex(/^[a-z0-9_]{3,40}$/);

export const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _./-]*$/u, "Tags use letters, digits, spaces and - _ . /");

export const createSpaceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  key: spaceKeySchema,
  description: z.string().trim().max(280).default(""),
});
export type CreateSpaceInput = z.infer<typeof createSpaceInputSchema>;

export const createPageInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const MAX_BODY_LENGTH = 200_000;
export const MAX_TAGS = 12;

export const saveDraftInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  body: z.string().max(MAX_BODY_LENGTH),
  tags: z
    .array(tagSchema)
    .max(MAX_TAGS)
    .transform((tags) => [...new Set(tags)]),
  visibility: z.enum(VISIBILITIES),
  sensitivity: z.enum(SENSITIVITIES),
  expectedVersion: z.number().int().min(0),
});
export type SaveDraftInput = z.infer<typeof saveDraftInputSchema>;

export const publishInputSchema = z.object({
  expectedDraftVersion: z.number().int().min(0),
});

export const searchInputSchema = z.object({
  q: z.string().trim().max(200).default(""),
  space: spaceKeySchema.optional(),
  tag: tagSchema.optional(),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

export const HUMAN_REVIEW_DECISIONS = [
  "still_valid",
  "update_needed",
  "archive_candidate",
] as const;
export type HumanReviewDecision = (typeof HUMAN_REVIEW_DECISIONS)[number];
