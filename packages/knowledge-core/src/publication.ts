import { Result } from "@praha/byethrow";

import type { PageAccess } from "./authorization.ts";
import {
  SENSITIVITIES,
  VISIBILITIES,
  type Draft,
  type Page,
  type PublicationSnapshot,
  type Revision,
  type Sensitivity,
  type Visibility,
} from "./model.ts";

export type PublicationValidationCode =
  | "forbidden"
  | "page_archived"
  | "revision_page_mismatch"
  | "space_mismatch"
  | "lifecycle_version_mismatch"
  | "invalid_publication_settings";

export class PublicationValidationError extends Error {
  constructor(
    readonly code: PublicationValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicationValidationError";
  }
}

type ContentLike = Pick<Revision, "title" | "body" | "tags">;

export function sameContent(left: ContentLike, right: ContentLike): boolean {
  return (
    left.title === right.title &&
    left.body === right.body &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  );
}

/**
 * Whether the draft differs from what is currently published: content or the
 * publication settings (visibility / sensitivity).
 */
export function hasUnpublishedChanges(
  draft: Draft,
  page: Pick<Page, "publishedVisibility" | "publishedSensitivity">,
  publishedRevision: ContentLike | null,
): boolean {
  if (publishedRevision === null) return true;
  return (
    !sameContent(draft, publishedRevision) ||
    draft.visibility !== page.publishedVisibility ||
    draft.sensitivity !== page.publishedSensitivity
  );
}

/**
 * Server-side validation before an immutable PublicationSnapshot is written.
 * Every value comes from stored state, never from the browser.
 */
export function validatePublicationSnapshot(input: {
  access: PageAccess;
  page: Pick<Page, "id" | "spaceId" | "status" | "lifecycleVersion">;
  revision: Pick<Revision, "pageId">;
  spaceId: string;
  visibility: Visibility;
  sensitivity: Sensitivity;
  expectedLifecycleVersion: number;
}): Result.Result<void, PublicationValidationError> {
  if (!input.access.publish) {
    return Result.fail(
      new PublicationValidationError("forbidden", "caller cannot publish this page"),
    );
  }
  if (input.page.status !== "active") {
    return Result.fail(new PublicationValidationError("page_archived", "page is archived"));
  }
  if (input.revision.pageId !== input.page.id) {
    return Result.fail(
      new PublicationValidationError(
        "revision_page_mismatch",
        "revision does not belong to the page",
      ),
    );
  }
  if (input.page.spaceId !== input.spaceId) {
    return Result.fail(
      new PublicationValidationError("space_mismatch", "page does not belong to the space"),
    );
  }
  if (input.expectedLifecycleVersion !== input.page.lifecycleVersion) {
    return Result.fail(
      new PublicationValidationError(
        "lifecycle_version_mismatch",
        "page lifecycle changed while preparing the publication",
      ),
    );
  }
  if (!VISIBILITIES.includes(input.visibility) || !SENSITIVITIES.includes(input.sensitivity)) {
    return Result.fail(
      new PublicationValidationError(
        "invalid_publication_settings",
        "unknown visibility or sensitivity",
      ),
    );
  }
  return Result.succeed();
}

export type PublishCommitDecision =
  | { type: "commit" }
  /** Same snapshot already committed: transport / executor replay. */
  | { type: "already_published" }
  /** A different lifecycle transition won: business-level concurrency. */
  | {
      type: "conflict";
      reason: "lifecycle_mismatch" | "archived";
      expectedLifecycleVersion: number;
      actualLifecycleVersion: number;
    };

/**
 * Compare-and-swap rule for `knowledge.revision.publish`. Replays of the same
 * snapshot are distinguished from competing publications / archive.
 */
export function decidePublishCommit(
  page: Pick<Page, "status" | "lifecycleVersion" | "publishedSnapshotId">,
  snapshot: Pick<PublicationSnapshot, "id" | "expectedLifecycleVersion">,
): PublishCommitDecision {
  if (page.publishedSnapshotId === snapshot.id) return { type: "already_published" };
  if (page.status !== "active") {
    return {
      type: "conflict",
      reason: "archived",
      expectedLifecycleVersion: snapshot.expectedLifecycleVersion,
      actualLifecycleVersion: page.lifecycleVersion,
    };
  }
  if (page.lifecycleVersion !== snapshot.expectedLifecycleVersion) {
    return {
      type: "conflict",
      reason: "lifecycle_mismatch",
      expectedLifecycleVersion: snapshot.expectedLifecycleVersion,
      actualLifecycleVersion: page.lifecycleVersion,
    };
  }
  return { type: "commit" };
}
