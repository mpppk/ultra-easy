import type { Result } from "@praha/byethrow";

import type { RelationshipOperation, RelationshipTuple } from "./authorization-admin.ts";
import type { ActionRequestId, OrganizationId } from "./domain/brand.ts";
import type { PrincipalRef } from "./domain/principal.ts";

/**
 * Console-managed relationship state (M9).
 *
 * D1 holds the desired state, per-tuple revision and mutation journal (the
 * source of truth for console-managed relationships). OpenFGA is the
 * authorization decision engine / projection. D1 and OpenFGA cannot commit
 * atomically, so no exactly-once external effect is claimed: every mutation
 * durably records intent before calling the provider, only the latest
 * per-tuple revision may be applied, and reconciliation converges the
 * provider to the latest desired state.
 */
export type RelationshipMutationStatus =
  | "prepared"
  | "applying"
  | "confirmed"
  | "indeterminate"
  | "superseded"
  | "failed";

/** Sync status of the latest desired revision of a tuple. */
export type RelationshipSyncStatus =
  | "prepared"
  | "applying"
  | "confirmed"
  | "indeterminate"
  | "failed";

export const RELATIONSHIP_SYNC_STATUSES: readonly RelationshipSyncStatus[] = [
  "prepared",
  "applying",
  "confirmed",
  "indeterminate",
  "failed",
];

export type AuthorizationRelationshipRecord = {
  organizationId: OrganizationId;
  tupleKey: string;
  tuple: RelationshipTuple;
  objectType: string;
  desiredPresent: boolean;
  revision: number;
  latestMutationKey: string;
  latestActionRequestId: ActionRequestId;
  confirmedRevision: number | null;
  confirmedPresent: boolean | null;
  syncStatus: RelationshipSyncStatus;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipMutationRecord = {
  organizationId: OrganizationId;
  mutationKey: string;
  actionRequestId: ActionRequestId;
  tupleKey: string;
  tuple: RelationshipTuple;
  revision: number;
  operation: RelationshipOperation;
  desiredPresent: boolean;
  actor: PrincipalRef;
  status: RelationshipMutationStatus;
  authorizationModelId: string;
  attemptCount: number;
  requestedAt: string;
  applyStartedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

export type RelationshipAuditEventType =
  | "authorization.relationship_change_requested"
  | "authorization.relationship_apply_started"
  | "authorization.relationship_change_confirmed"
  | "authorization.relationship_change_indeterminate"
  | "authorization.relationship_change_superseded"
  | "authorization.relationship_change_failed"
  | "authorization.relationship_drift_repaired";

export const RELATIONSHIP_AUDIT_EVENT_TYPES: readonly RelationshipAuditEventType[] = [
  "authorization.relationship_change_requested",
  "authorization.relationship_apply_started",
  "authorization.relationship_change_confirmed",
  "authorization.relationship_change_indeterminate",
  "authorization.relationship_change_superseded",
  "authorization.relationship_change_failed",
  "authorization.relationship_drift_repaired",
];

/**
 * Append-only audit of relationship mutation. `requested` records intent
 * (durable before any provider call); `confirmed` is only written after the
 * provider effect was observed. Never carries full Action input or PII
 * display values.
 */
export type RelationshipAuditEvent = {
  sequence: number;
  organizationId: OrganizationId;
  eventKey: string;
  type: RelationshipAuditEventType;
  occurredAt: string;
  actor: PrincipalRef;
  sourceActionRequestId: ActionRequestId;
  mutationKey: string;
  tupleKey: string;
  revision: number;
  operation: RelationshipOperation;
  desiredPresent: boolean;
  tuple: RelationshipTuple;
  authorizationModelId: string;
  errorCode: string | null;
};

export class AuthorizationRelationshipRepositoryError extends Error {
  readonly name = "AuthorizationRelationshipRepositoryError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type RelationshipListFilter = {
  organizationId: OrganizationId;
  subject?: string;
  relation?: string;
  object?: string;
  syncStatus?: RelationshipSyncStatus;
  cursor?: string;
  limit: number;
};

export type RelationshipPage<T> = { items: T[]; nextCursor: string | null };

export type RelationshipAuditFilter = {
  organizationId: OrganizationId;
  actorId?: string;
  eventType?: RelationshipAuditEventType;
  operation?: RelationshipOperation;
  subject?: string;
  relation?: string;
  object?: string;
  sourceActionRequestId?: string;
  mutationKey?: string;
  revision?: number;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

/** Tenant-scoped read side. Never scans the shared FGA store. */
export interface AuthorizationRelationshipReadRepository {
  list(
    filter: RelationshipListFilter,
  ): Result.ResultAsync<
    RelationshipPage<AuthorizationRelationshipRecord>,
    AuthorizationRelationshipRepositoryError
  >;

  get(input: { organizationId: OrganizationId; tupleKey: string }): Result.ResultAsync<
    {
      relationship: AuthorizationRelationshipRecord;
      mutations: RelationshipMutationRecord[];
    } | null,
    AuthorizationRelationshipRepositoryError
  >;

  listAudit(
    filter: RelationshipAuditFilter,
  ): Result.ResultAsync<
    RelationshipPage<RelationshipAuditEvent>,
    AuthorizationRelationshipRepositoryError
  >;
}

/** How a failed provider call relates to the side effect (see OpenFGA adapter). */
export type RelationshipGatewayFailureEffect = "not_sent" | "rejected" | "ambiguous";

export class RelationshipGatewayError extends Error {
  readonly name = "RelationshipGatewayError";

  constructor(
    readonly code: string,
    readonly effect: RelationshipGatewayFailureEffect,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Provider port for console-managed tuples. Implementations scope the logical
 * object to the organization. Only the relationship executor / reconciler
 * holds this capability; the admin read API never does.
 */
export interface RelationshipTupleGateway {
  readonly authorizationModelId: string;
  /** Exact, higher-consistency read of the provider state. */
  read(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
  }): Result.ResultAsync<boolean, RelationshipGatewayError>;
  /** Makes the tuple present (write) or absent (delete). */
  apply(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
    present: boolean;
  }): Result.ResultAsync<void, RelationshipGatewayError>;
}

export type PrepareRelationshipMutationInput = {
  organizationId: OrganizationId;
  mutationKey: string;
  actionRequestId: ActionRequestId;
  tupleKey: string;
  tuple: RelationshipTuple;
  objectType: string;
  operation: RelationshipOperation;
  desiredPresent: boolean;
  actor: PrincipalRef;
  authorizationModelId: string;
  requestedAt: string;
};

export type LoadedRelationshipMutation = {
  mutation: RelationshipMutationRecord;
  relationship: AuthorizationRelationshipRecord;
};

export type ReconcilableTuple = { organizationId: OrganizationId; tupleKey: string };

/**
 * Write side of the relationship journal. Every transition is a single D1
 * atomic batch (state + audit event) guarded by the per-tuple revision, so a
 * stale mutation can never overwrite a newer desired state.
 */
export interface AuthorizationRelationshipStore {
  /**
   * Phase 1 (before any provider call): allocate the next per-tuple revision,
   * persist the `prepared` intent, update the desired state and append the
   * `requested` audit event atomically. Idempotent per mutationKey: a retry
   * returns the existing mutation and never issues a new revision.
   */
  prepare(
    input: PrepareRelationshipMutationInput,
  ): Result.ResultAsync<LoadedRelationshipMutation, AuthorizationRelationshipRepositoryError>;

  load(input: {
    organizationId: OrganizationId;
    mutationKey: string;
  }): Result.ResultAsync<
    LoadedRelationshipMutation | null,
    AuthorizationRelationshipRepositoryError
  >;

  /** Mutation whose revision equals the tuple's latest desired revision. */
  loadLatest(input: {
    organizationId: OrganizationId;
    tupleKey: string;
  }): Result.ResultAsync<
    LoadedRelationshipMutation | null,
    AuthorizationRelationshipRepositoryError
  >;

  /** Only the latest revision may enter `applying`. */
  markApplying(input: {
    mutation: RelationshipMutationRecord;
    at: string;
  }): Result.ResultAsync<
    "applying" | "not_latest" | "terminal",
    AuthorizationRelationshipRepositoryError
  >;

  /** Confirms only while still latest; also advances the tuple's confirmed revision. */
  markConfirmed(input: {
    mutation: RelationshipMutationRecord;
    observedPresent: boolean;
    at: string;
  }): Result.ResultAsync<"confirmed" | "not_latest", AuthorizationRelationshipRepositoryError>;

  /** Supersedes every open mutation of the tuple older than its latest revision. */
  supersedeStale(input: {
    organizationId: OrganizationId;
    tupleKey: string;
    at: string;
  }): Result.ResultAsync<number, AuthorizationRelationshipRepositoryError>;

  markIndeterminate(input: {
    mutation: RelationshipMutationRecord;
    errorCode: string;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError>;

  markFailed(input: {
    mutation: RelationshipMutationRecord;
    errorCode: string;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError>;

  /** Records a provider drift repair of an already-confirmed latest revision. */
  recordDriftRepaired(input: {
    mutation: RelationshipMutationRecord;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError>;

  /**
   * Tuples needing reconciliation: indeterminate mutations immediately, and
   * prepared/applying mutations idle longer than the grace period (crash or
   * lost response; the grace period avoids racing a live execution).
   */
  listReconcilable(input: {
    organizationId: OrganizationId;
    idleBefore: string;
    limit: number;
  }): Result.ResultAsync<ReconcilableTuple[], AuthorizationRelationshipRepositoryError>;
}
