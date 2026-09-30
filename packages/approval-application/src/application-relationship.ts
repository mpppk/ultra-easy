import type { Result } from "@praha/byethrow";

import type { OrganizationId, UserId } from "@app/approval-core";

export class ApplicationRelationshipReadError extends Error {
  override readonly name = "ApplicationRelationshipReadError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type SpaceRole = "viewer" | "editor" | "owner";
export type SpaceRoleEntry = { spaceId: string; role: SpaceRole };
export type SpaceMemberEntry = { id: UserId; displayName: string; role: SpaceRole };
export type SpaceRoleCursor = { object: string; relation: string };
export type SpaceMemberCursor = { subject: string; relation: string };

export interface ApplicationRelationshipReadRepository {
  roles(input: {
    organizationId: OrganizationId;
    subject: UserId;
    after?: SpaceRoleCursor;
    limit: number;
  }): Result.ResultAsync<SpaceRoleEntry[], ApplicationRelationshipReadError>;

  members(input: {
    organizationId: OrganizationId;
    spaceId: string;
    after?: SpaceMemberCursor;
    limit: number;
  }): Result.ResultAsync<SpaceMemberEntry[], ApplicationRelationshipReadError>;
}
