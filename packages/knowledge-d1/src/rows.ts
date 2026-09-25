import type {
  Draft,
  Page,
  PublicationEffect,
  PublicationEffectKind,
  PublicationEffectStatus,
  PublicationOutcome,
  PublicationSnapshot,
  ReviewState,
  Revision,
  Sensitivity,
  Space,
  Visibility,
} from "@app/knowledge-core";

import { parseTags } from "./db.ts";

export type SpaceRow = {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
};

export const toSpace = (row: SpaceRow): Space => ({
  id: row.id,
  organizationId: row.organization_id,
  key: row.key,
  name: row.name,
  description: row.description,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export type PageRow = {
  id: string;
  space_id: string;
  owner_id: string;
  status: "active" | "archived";
  lifecycle_version: number;
  published_revision_id: string | null;
  published_snapshot_id: string | null;
  published_visibility: Visibility | null;
  published_sensitivity: Sensitivity | null;
  published_at: string | null;
  published_by: string | null;
  review_state: ReviewState;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const PAGE_COLUMNS = `p.id, p.space_id, p.owner_id, p.status, p.lifecycle_version,
  p.published_revision_id, p.published_snapshot_id, p.published_visibility, p.published_sensitivity,
  p.published_at, p.published_by, p.review_state, p.last_reviewed_at, p.created_at, p.updated_at`;

export const toPage = (row: PageRow): Page => ({
  id: row.id,
  spaceId: row.space_id,
  ownerId: row.owner_id,
  status: row.status,
  lifecycleVersion: Number(row.lifecycle_version),
  publishedRevisionId: row.published_revision_id,
  publishedSnapshotId: row.published_snapshot_id,
  publishedVisibility: row.published_visibility,
  publishedSensitivity: row.published_sensitivity,
  publishedAt: row.published_at,
  publishedBy: row.published_by,
  reviewState: row.review_state,
  lastReviewedAt: row.last_reviewed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type DraftRow = {
  page_id: string;
  title: string;
  body: string;
  tags_json: string;
  visibility: Visibility;
  sensitivity: Sensitivity;
  version: number;
  updated_by: string;
  updated_at: string;
};

export const toDraft = (row: DraftRow): Draft => ({
  pageId: row.page_id,
  title: row.title,
  body: row.body,
  tags: parseTags(row.tags_json),
  visibility: row.visibility,
  sensitivity: row.sensitivity,
  version: Number(row.version),
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

export type RevisionRow = {
  id: string;
  page_id: string;
  number: number;
  title: string;
  body: string;
  tags_json: string;
  created_by: string;
  created_at: string;
};

export const toRevision = (row: RevisionRow): Revision => ({
  id: row.id,
  pageId: row.page_id,
  number: Number(row.number),
  title: row.title,
  body: row.body,
  tags: parseTags(row.tags_json),
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export type SnapshotRow = {
  id: string;
  page_id: string;
  revision_id: string;
  revision_number: number;
  space_id: string;
  visibility: Visibility;
  sensitivity: Sensitivity;
  expected_lifecycle_version: number;
  created_by: string;
  created_at: string;
};

export const toSnapshot = (row: SnapshotRow): PublicationSnapshot => ({
  id: row.id,
  pageId: row.page_id,
  revisionId: row.revision_id,
  revisionNumber: Number(row.revision_number),
  spaceId: row.space_id,
  visibility: row.visibility,
  sensitivity: row.sensitivity,
  expectedLifecycleVersion: Number(row.expected_lifecycle_version),
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export type OutcomeRow = {
  publication_snapshot_id: string;
  status: "published" | "conflict";
  reason: "lifecycle_mismatch" | "archived" | null;
  expected_lifecycle_version: number;
  actual_lifecycle_version: number;
  recorded_at: string;
};

export const toOutcome = (row: OutcomeRow): PublicationOutcome =>
  row.status === "published"
    ? { snapshotId: row.publication_snapshot_id, status: "published", recordedAt: row.recorded_at }
    : {
        snapshotId: row.publication_snapshot_id,
        status: "conflict",
        reason: row.reason ?? "lifecycle_mismatch",
        expectedLifecycleVersion: Number(row.expected_lifecycle_version),
        actualLifecycleVersion: Number(row.actual_lifecycle_version),
        recordedAt: row.recorded_at,
      };

export type EffectRow = {
  publication_snapshot_id: string;
  effect: PublicationEffectKind;
  status: PublicationEffectStatus;
  attempts: number;
  last_error_code: string | null;
  updated_at: string;
};

export const toEffect = (row: EffectRow): PublicationEffect => ({
  publicationSnapshotId: row.publication_snapshot_id,
  effect: row.effect,
  status: row.status,
  attempts: Number(row.attempts),
  lastErrorCode: row.last_error_code,
  updatedAt: row.updated_at,
});
