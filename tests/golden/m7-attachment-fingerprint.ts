export const m7AttachmentFingerprintGolden = {
  actionDefinitionKey: "ticket-attachment",
  actionDefinitionVersion: 1,
  actionType: "ticket.update",
  resourceType: "ticket",
  resourceId: "TICKET-1",
  attachment: {
    storageKey: "org:test/attachments/quote.pdf",
    sha256: `sha256:${"1".repeat(64)}`,
    size: 1234,
    contentType: "application/pdf",
  },
  expectedActionFingerprint:
    "sha256:45ccaf3f5e5e2f6860a82d11613ea6fd6084a87fa307cb15a8ad598301f2eafc",
} as const;
