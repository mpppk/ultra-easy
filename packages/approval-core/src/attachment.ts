import { Result } from "@praha/byethrow";
import { sha256Digest } from "./domain/brand.ts";

import type { OrganizationId, Sha256Digest } from "./domain/brand.ts";
import type { JsonObject, JsonValue } from "./domain/json.ts";

export type AttachmentReference = {
  storageKey: string;
  sha256: Sha256Digest;
  size: number;
  contentType: string;
};

export type AttachmentObjectMetadata = AttachmentReference & {
  organizationId: OrganizationId;
};

export type AttachmentRetentionMetadata = {
  organizationId: OrganizationId;
  reference: AttachmentReference;
  retainUntil: string;
};

export type AttachmentAccessGrant = {
  url: string;
  expiresAt: string;
};

export class AttachmentStorageError extends Error {
  readonly name = "AttachmentStorageError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface AttachmentStorage {
  head(input: {
    organizationId: OrganizationId;
    storageKey: string;
  }): Result.ResultAsync<AttachmentObjectMetadata | null, AttachmentStorageError>;

  read(input: {
    organizationId: OrganizationId;
    storageKey: string;
  }): Result.ResultAsync<Uint8Array, AttachmentStorageError>;

  createShortLivedAccess(input: {
    organizationId: OrganizationId;
    storageKey: string;
    expiresInSeconds: number;
  }): Result.ResultAsync<AttachmentAccessGrant, AttachmentStorageError>;
}

export type AttachmentIntegrityErrorCode =
  | "invalid_attachment_reference"
  | "attachment_not_found"
  | "attachment_tenant_mismatch"
  | "attachment_metadata_mismatch"
  | "attachment_size_mismatch"
  | "attachment_hash_mismatch"
  | "attachment_hash_failed"
  | "attachment_storage_error"
  | "invalid_attachment_access_ttl"
  | "invalid_retention_timestamp";

export class AttachmentIntegrityError extends Error {
  readonly name = "AttachmentIntegrityError";

  constructor(
    readonly code: AttachmentIntegrityErrorCode,
    message: string,
    readonly retriable = false,
    readonly cause?: Error,
  ) {
    super(message);
  }
}

function integrityFailure<T>(
  code: AttachmentIntegrityErrorCode,
  message: string,
): Result.Result<T, AttachmentIntegrityError> {
  return Result.fail(new AttachmentIntegrityError(code, message));
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function validateAttachmentReference(
  reference: AttachmentReference,
): Result.Result<void, AttachmentIntegrityError> {
  if (reference.storageKey.trim().length === 0) {
    return integrityFailure("invalid_attachment_reference", "attachment storageKeyは必須です");
  }
  if (!SHA256_PATTERN.test(String(reference.sha256))) {
    return integrityFailure(
      "invalid_attachment_reference",
      "attachment sha256はsha256:<lowercase-hex>形式である必要があります",
    );
  }
  if (!Number.isSafeInteger(reference.size) || reference.size < 0) {
    return integrityFailure(
      "invalid_attachment_reference",
      "attachment sizeは0以上のsafe integerである必要があります",
    );
  }
  if (reference.contentType.trim().length === 0) {
    return integrityFailure("invalid_attachment_reference", "attachment contentTypeは必須です");
  }
  return Result.succeed(undefined);
}

export function isAttachmentReference(value: unknown): value is AttachmentReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.storageKey !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.size !== "number" ||
    typeof record.contentType !== "string"
  ) {
    return false;
  }
  return Result.isSuccess(validateAttachmentReference(record as AttachmentReference));
}

export type LocatedAttachmentReference = {
  path: string;
  reference: AttachmentReference;
};

export function collectAttachmentReferences(
  value: JsonValue,
  path = "$",
): LocatedAttachmentReference[] {
  if (isAttachmentReference(value)) {
    return [{ path, reference: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectAttachmentReferences(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];

  const references: LocatedAttachmentReference[] = [];
  for (const key of Object.keys(value).sort()) {
    references.push(...collectAttachmentReferences(value[key] as JsonValue, `${path}.${key}`));
  }
  return references;
}

function storageFailure(error: AttachmentStorageError): AttachmentIntegrityError {
  return new AttachmentIntegrityError(
    "attachment_storage_error",
    error.message,
    error.retriable,
    error,
  );
}

function verifyStoredMetadata(input: {
  requestedOrganizationId: OrganizationId;
  reference: AttachmentReference;
  metadata: AttachmentObjectMetadata | null;
}): Result.Result<void, AttachmentIntegrityError> {
  if (!input.metadata) {
    return integrityFailure(
      "attachment_not_found",
      `attachmentが見つかりません: ${input.reference.storageKey}`,
    );
  }
  if (String(input.metadata.organizationId) !== String(input.requestedOrganizationId)) {
    return integrityFailure(
      "attachment_tenant_mismatch",
      "attachmentのorganization scopeが一致しません",
    );
  }
  if (
    input.metadata.storageKey !== input.reference.storageKey ||
    String(input.metadata.sha256) !== String(input.reference.sha256) ||
    input.metadata.size !== input.reference.size ||
    input.metadata.contentType !== input.reference.contentType
  ) {
    return integrityFailure(
      "attachment_metadata_mismatch",
      "attachment referenceとstored metadataが一致しません",
    );
  }
  return Result.succeed(undefined);
}

const digestBytes = Result.fn({
  try: async (content: Uint8Array): Promise<Sha256Digest> => {
    const copied = Uint8Array.from(content);
    const digest = await crypto.subtle.digest("SHA-256", copied);
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return sha256Digest(hex);
  },
  catch: (): AttachmentIntegrityError =>
    new AttachmentIntegrityError(
      "attachment_hash_failed",
      "attachment contentのSHA-256計算に失敗しました",
    ),
});

export async function readVerifiedAttachment(
  storage: AttachmentStorage,
  input: {
    organizationId: OrganizationId;
    reference: AttachmentReference;
  },
): Result.ResultAsync<Uint8Array, AttachmentIntegrityError> {
  const validReference = validateAttachmentReference(input.reference);
  if (Result.isFailure(validReference)) return validReference;

  const metadata = await storage.head({
    organizationId: input.organizationId,
    storageKey: input.reference.storageKey,
  });
  if (Result.isFailure(metadata)) return Result.fail(storageFailure(metadata.error));

  const metadataVerification = verifyStoredMetadata({
    requestedOrganizationId: input.organizationId,
    reference: input.reference,
    metadata: metadata.value,
  });
  if (Result.isFailure(metadataVerification)) return metadataVerification;

  const content = await storage.read({
    organizationId: input.organizationId,
    storageKey: input.reference.storageKey,
  });
  if (Result.isFailure(content)) return Result.fail(storageFailure(content.error));

  if (content.value.byteLength !== input.reference.size) {
    return integrityFailure(
      "attachment_size_mismatch",
      `attachment sizeが一致しません: expected=${input.reference.size}, actual=${content.value.byteLength}`,
    );
  }

  const digest = await digestBytes(content.value);
  if (Result.isFailure(digest)) return digest;
  if (String(digest.value) !== String(input.reference.sha256)) {
    return integrityFailure(
      "attachment_hash_mismatch",
      `attachment hashが一致しません: ${input.reference.storageKey}`,
    );
  }
  return Result.succeed(content.value);
}

export async function verifyActionAttachments(
  storage: AttachmentStorage,
  input: {
    organizationId: OrganizationId;
    actionInput: JsonObject;
  },
): Result.ResultAsync<void, AttachmentIntegrityError> {
  for (const located of collectAttachmentReferences(input.actionInput)) {
    const verified = await readVerifiedAttachment(storage, {
      organizationId: input.organizationId,
      reference: located.reference,
    });
    if (Result.isFailure(verified)) return verified;
  }
  return Result.succeed(undefined);
}

export async function createTenantScopedAttachmentAccess(
  storage: AttachmentStorage,
  input: {
    organizationId: OrganizationId;
    reference: AttachmentReference;
    expiresInSeconds: number;
  },
): Result.ResultAsync<AttachmentAccessGrant, AttachmentIntegrityError> {
  if (
    !Number.isSafeInteger(input.expiresInSeconds) ||
    input.expiresInSeconds <= 0 ||
    input.expiresInSeconds > 3600
  ) {
    return integrityFailure(
      "invalid_attachment_access_ttl",
      "attachment access TTLは1〜3600秒である必要があります",
    );
  }

  const validReference = validateAttachmentReference(input.reference);
  if (Result.isFailure(validReference)) return validReference;

  const metadata = await storage.head({
    organizationId: input.organizationId,
    storageKey: input.reference.storageKey,
  });
  if (Result.isFailure(metadata)) return Result.fail(storageFailure(metadata.error));

  const metadataVerification = verifyStoredMetadata({
    requestedOrganizationId: input.organizationId,
    reference: input.reference,
    metadata: metadata.value,
  });
  if (Result.isFailure(metadataVerification)) return metadataVerification;

  const access = await storage.createShortLivedAccess({
    organizationId: input.organizationId,
    storageKey: input.reference.storageKey,
    expiresInSeconds: input.expiresInSeconds,
  });
  return Result.isFailure(access) ? Result.fail(storageFailure(access.error)) : access;
}

export function selectAttachmentPurgeCandidates(
  records: readonly AttachmentRetentionMetadata[],
  input: {
    organizationId: OrganizationId;
    now: string;
  },
): Result.Result<AttachmentRetentionMetadata[], AttachmentIntegrityError> {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    return integrityFailure("invalid_retention_timestamp", `retention nowが不正です: ${input.now}`);
  }

  const candidates: AttachmentRetentionMetadata[] = [];
  for (const record of records) {
    if (String(record.organizationId) !== String(input.organizationId)) continue;
    const retainUntil = Date.parse(record.retainUntil);
    if (!Number.isFinite(retainUntil)) {
      return integrityFailure(
        "invalid_retention_timestamp",
        `retainUntilが不正です: ${record.retainUntil}`,
      );
    }
    if (retainUntil <= now) candidates.push(record);
  }

  return Result.succeed(
    candidates.sort((left, right) => {
      const byTime = left.retainUntil.localeCompare(right.retainUntil);
      return byTime !== 0
        ? byTime
        : left.reference.storageKey.localeCompare(right.reference.storageKey);
    }),
  );
}
