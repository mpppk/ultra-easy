import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { m7AttachmentFingerprintGolden } from "../golden/m7-attachment-fingerprint.ts";

import {
  collectAttachmentReferences,
  computeActionFingerprint,
  computeApprovalBindingFingerprint,
  createTenantScopedAttachmentAccess,
  readVerifiedAttachment,
  selectAttachmentPurgeCandidates,
  verifyActionAttachments,
} from "@app/approval-core";
import type {
  ActionDefinitionKey,
  ApprovalPlanChecksum,
  AttachmentObjectMetadata,
  AttachmentReference,
  AttachmentRetentionMetadata,
  AttachmentStorage,
  EvaluationSnapshotChecksum,
  ExecutorKey,
  MaterializedActionSnapshot,
  OrganizationId,
  ResourceId,
  ResourceType,
  SchemaKey,
  Sha256Digest,
} from "@app/approval-core";

function branded<T extends string>(value: string): T {
  return value as T;
}

const orgA = branded<OrganizationId>("org:a");
const orgB = branded<OrganizationId>("org:b");

function reference(input: Partial<AttachmentReference> = {}): AttachmentReference {
  return {
    storageKey: input.storageKey ?? "org:a/attachments/quote.pdf",
    sha256:
      input.sha256 ??
      branded<Sha256Digest>(
        "sha256:5702404bec3e027229def7d2c67d97dc5be952a6c4b35b9b6ae5cc951f83b6e7",
      ),
    size: input.size ?? 19,
    contentType: input.contentType ?? "application/pdf",
  };
}

function action(attachment: AttachmentReference): MaterializedActionSnapshot {
  return {
    definition: {
      key: branded<ActionDefinitionKey>("ticket-attachment"),
      version: 1,
      actionType: branded("ticket.update"),
      inputSchema: { key: branded<SchemaKey>("ticket-update-input"), version: 1 },
      executorKey: branded<ExecutorKey>("ticket-update"),
    },
    type: branded("ticket.update"),
    resource: {
      type: branded<ResourceType>("ticket"),
      id: branded<ResourceId>("TICKET-1"),
    },
    input: { attachment },
  };
}

class MemoryAttachmentStorage implements AttachmentStorage {
  constructor(
    readonly metadata: AttachmentObjectMetadata | null,
    readonly bytes: Uint8Array,
  ) {}

  head() {
    return Promise.resolve(Result.succeed(this.metadata));
  }

  read() {
    return Promise.resolve(Result.succeed(this.bytes));
  }

  createShortLivedAccess(input: { expiresInSeconds: number }) {
    return Promise.resolve(
      Result.succeed({
        url: "https://attachments.example.test/signed",
        expiresAt: new Date(
          Date.parse("2026-09-20T00:00:00.000Z") + input.expiresInSeconds * 1000,
        ).toISOString(),
      }),
    );
  }
}

function metadata(
  organizationId: OrganizationId,
  attachment = reference(),
): AttachmentObjectMetadata {
  return { organizationId, ...attachment };
}

describe("M7 attachment integrity", () => {
  it("AC-M7-006: same attachment hash keeps actionFingerprint stable", async () => {
    const first = await computeActionFingerprint(action(reference()));
    const second = await computeActionFingerprint(action(reference()));

    assert(Result.isSuccess(first));
    assert(Result.isSuccess(second));
    expect(first.value).toBe(second.value);
  });

  it("AC-M7-006: same storageKeyでもsha256差替えは別Action/bindingになる", async () => {
    const original = await computeActionFingerprint(action(reference()));
    const replaced = await computeActionFingerprint(
      action(
        reference({
          sha256: branded<Sha256Digest>(`sha256:${"1".repeat(64)}`),
        }),
      ),
    );

    assert(Result.isSuccess(original));
    assert(Result.isSuccess(replaced));
    expect(replaced.value).not.toBe(original.value);

    const evaluationSnapshotChecksum = branded<EvaluationSnapshotChecksum>(
      `sha256:${"2".repeat(64)}`,
    );
    const approvalPlanChecksum = branded<ApprovalPlanChecksum>(`sha256:${"3".repeat(64)}`);
    const originalBinding = await computeApprovalBindingFingerprint({
      actionFingerprint: original.value,
      evaluationSnapshotChecksum,
      approvalPlanChecksum,
    });
    const replacedBinding = await computeApprovalBindingFingerprint({
      actionFingerprint: replaced.value,
      evaluationSnapshotChecksum,
      approvalPlanChecksum,
    });
    assert(Result.isSuccess(originalBinding));
    assert(Result.isSuccess(replacedBinding));
    expect(replacedBinding.value).not.toBe(originalBinding.value);
  });

  it("AC-M7-006: golden attachment fingerprintを固定する", async () => {
    const result = await computeActionFingerprint(
      action(
        reference({
          storageKey: m7AttachmentFingerprintGolden.attachment.storageKey,
          sha256: branded<Sha256Digest>(m7AttachmentFingerprintGolden.attachment.sha256),
          size: m7AttachmentFingerprintGolden.attachment.size,
          contentType: m7AttachmentFingerprintGolden.attachment.contentType,
        }),
      ),
    );
    assert(Result.isSuccess(result));
    expect(result.value).toBe(m7AttachmentFingerprintGolden.expectedActionFingerprint);
  });

  it("AC-M7-006: cross-tenant metadataはaccess/readをfail closedする", async () => {
    const storage = new MemoryAttachmentStorage(
      metadata(orgB),
      new TextEncoder().encode("approved attachment"),
    );

    const read = await readVerifiedAttachment(storage, {
      organizationId: orgA,
      reference: reference(),
    });
    assert(Result.isFailure(read));
    expect(read.error.code).toBe("attachment_tenant_mismatch");

    const access = await createTenantScopedAttachmentAccess(storage, {
      organizationId: orgA,
      reference: reference(),
      expiresInSeconds: 300,
    });
    assert(Result.isFailure(access));
    expect(access.error.code).toBe("attachment_tenant_mismatch");
  });

  it("AC-M7-006: content hash mismatchはexecute preflightでfail closedする", async () => {
    const storage = new MemoryAttachmentStorage(
      metadata(orgA),
      new TextEncoder().encode("tampered attachment"),
    );

    const verified = await verifyActionAttachments(storage, {
      organizationId: orgA,
      actionInput: action(reference()).input,
    });
    assert(Result.isFailure(verified));
    expect(verified.error.code).toBe("attachment_hash_mismatch");
  });

  it("AC-M7-006: nested attachment referencesを決定的に収集する", () => {
    const refs = collectAttachmentReferences({
      z: reference({ storageKey: "z" }),
      a: [{ value: reference({ storageKey: "a" }) }],
    });
    expect(refs.map((item) => [item.path, item.reference.storageKey])).toEqual([
      ["$.a[0].value", "a"],
      ["$.z", "z"],
    ]);
  });

  it("retention purge selectionはtenant scopeとretainUntilを守る", () => {
    const records: AttachmentRetentionMetadata[] = [
      {
        organizationId: orgA,
        reference: reference({ storageKey: "expired" }),
        retainUntil: "2026-09-19T00:00:00.000Z",
      },
      {
        organizationId: orgA,
        reference: reference({ storageKey: "future" }),
        retainUntil: "2026-09-21T00:00:00.000Z",
      },
      {
        organizationId: orgB,
        reference: reference({ storageKey: "other-tenant" }),
        retainUntil: "2026-09-18T00:00:00.000Z",
      },
    ];

    const selected = selectAttachmentPurgeCandidates(records, {
      organizationId: orgA,
      now: "2026-09-20T00:00:00.000Z",
    });
    assert(Result.isSuccess(selected));
    expect(selected.value.map((item) => item.reference.storageKey)).toEqual(["expired"]);
  });
});
