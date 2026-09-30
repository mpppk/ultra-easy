import type { Result } from "@praha/byethrow";

import type { OrganizationId, UserId } from "@app/approval-core";

export type PrincipalDirectoryEntry = {
  id: UserId;
  displayName: string;
};

export class PrincipalDirectoryError extends Error {
  override readonly name = "PrincipalDirectoryError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface PrincipalDirectoryRepository {
  list(input: {
    organizationId: OrganizationId;
    after?: PrincipalDirectoryEntry;
    limit: number;
  }): Result.ResultAsync<PrincipalDirectoryEntry[], PrincipalDirectoryError>;

  upsert(input: {
    organizationId: OrganizationId;
    principal: PrincipalDirectoryEntry;
    now: string;
  }): Result.ResultAsync<void, PrincipalDirectoryError>;
}
