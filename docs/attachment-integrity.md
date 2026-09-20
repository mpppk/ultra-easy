# Attachment integrity and retention

M7 binds attachment identity to the Action instead of embedding attachment bytes in Action input.

## Canonical reference

Action input stores only this JSON shape:

```ts
type AttachmentReference = {
  storageKey: string;
  sha256: Sha256Digest; // sha256:<64 lowercase hex>
  size: number;
  contentType: string;
};
```

Because the complete reference is part of the materialized Action input, `sha256` is included in
`actionFingerprint`. Replacing the object at the same `storageKey` with different bytes therefore
produces a different Action and a different `approvalBindingFingerprint`.

## Storage and access boundary

`AttachmentStorage` is the object-storage port. Every operation receives `organizationId` and
`storageKey`; adapters such as R2 must enforce this tenant scope. The core additionally verifies
that returned object metadata belongs to the requested organization and exactly matches the
immutable reference before issuing a short-lived access URL.

Signed access is limited by the core contract to 1–3600 seconds.

## Read / execution verification

Before an executor consumes attachment bytes, call `verifyActionAttachments` (or
`readVerifiedAttachment` for one reference). Verification is fail-closed:

1. validate the canonical reference;
2. load tenant-scoped stored metadata;
3. compare organization, storage key, SHA-256, size, and content type;
4. read the bytes;
5. compare byte length;
6. recompute SHA-256 and compare it with the approved reference.

A mismatch must stop execution; the old approval must not be reused for modified content.

## Retention

`AttachmentRetentionMetadata` stores `organizationId`, the immutable reference, and
`retainUntil`. `selectAttachmentPurgeCandidates` returns only expired records in the requested
tenant. Invalid retention timestamps fail closed. Archive/legal-hold/crypto-shredding policies
remain outside the v1 scope.
