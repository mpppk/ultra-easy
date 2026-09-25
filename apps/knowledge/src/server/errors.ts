import type { KnowledgeStoreError } from "@app/knowledge-d1";

import type { UltraEasyError } from "../ultra-easy/client.ts";

export type ServiceErrorCode =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "validation_error"
  | "duplicate_key"
  | "draft_conflict"
  | "invalid_state"
  | "publication_invalid"
  | "store_unavailable"
  | "platform_unavailable";

const STATUS: Record<ServiceErrorCode, number> = {
  unauthenticated: 401,
  // not_found and forbidden on a resource both surface as 404 (no existence leak)
  not_found: 404,
  forbidden: 403,
  validation_error: 422,
  duplicate_key: 409,
  draft_conflict: 409,
  invalid_state: 409,
  publication_invalid: 409,
  store_unavailable: 503,
  platform_unavailable: 503,
};

/** Error surfaced to the UI by stable code (never raw provider / SQL text). */
export class KnowledgeServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
    this.name = "KnowledgeServiceError";
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const notFound = () =>
  new KnowledgeServiceError("not_found", "Not found or you do not have access");

export const forbidden = (title = "You do not have permission to do this") =>
  new KnowledgeServiceError("forbidden", title);

export const storeError = (error: KnowledgeStoreError) =>
  error.code === "duplicate_key"
    ? new KnowledgeServiceError("duplicate_key", "That key is already in use")
    : error.code === "draft_conflict"
      ? new KnowledgeServiceError(
          "draft_conflict",
          "Someone else changed this draft",
          "Reload to get the latest version before saving again.",
        )
      : new KnowledgeServiceError("store_unavailable", "Knowledge storage is unavailable");

export const platformError = (error: UltraEasyError) =>
  error.code === "forbidden"
    ? new KnowledgeServiceError("forbidden", "ultra-easy denied this request", error.message)
    : error.code === "not_found"
      ? notFound()
      : error.code === "invalid_state" || error.code === "invalid_request"
        ? new KnowledgeServiceError("invalid_state", error.message)
        : new KnowledgeServiceError("platform_unavailable", "ultra-easy is unavailable");
