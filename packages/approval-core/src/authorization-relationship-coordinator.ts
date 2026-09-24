import { Result } from "@praha/byethrow";

import {
  ActionExecutorError,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
} from "./action-execution.ts";
import {
  AUTHORIZATION_ADMIN_OBJECT_TYPE,
  AUTHORIZATION_ADMIN_ROOT_ID,
  DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
  relationshipTupleKey,
  validateRelationshipUpdateInput,
  type AuthorizationRelationshipUpdateInput,
  type ManagedRelationshipCatalog,
} from "./authorization-admin.ts";
import {
  AuthorizationRelationshipRepositoryError,
  type AuthorizationRelationshipStore,
  type LoadedRelationshipMutation,
  type RelationshipMutationRecord,
  type RelationshipMutationStatus,
  type RelationshipTupleGateway,
} from "./authorization-relationship.ts";
import type { ActionRequestId, OrganizationId } from "./domain/brand.ts";
import type { PrincipalRef } from "./domain/principal.ts";

export type RelationshipMutationOutcome = {
  status: RelationshipMutationStatus;
  mutation: RelationshipMutationRecord;
  errorCode?: string;
};

type Outcome = Result.Result<RelationshipMutationOutcome, AuthorizationRelationshipRepositoryError>;

const TERMINAL: ReadonlySet<RelationshipMutationStatus> = new Set([
  "confirmed",
  "superseded",
  "failed",
]);

/**
 * Governed relationship mutation protocol (M9-2).
 *
 * 1. prepare: durable intent + desired state + `requested` audit (D1 batch)
 *    before any provider call.
 * 2. apply: only the tuple's latest revision may reach the provider; a stale
 *    mutation is `superseded` without a provider call.
 * 3. observe/confirm: success is only recorded after an exact provider read
 *    shows the desired state. Ambiguous failures become `indeterminate` and
 *    are never retried by assuming "not applied".
 *
 * Reconciliation re-applies only the latest desired revision. No
 * exactly-once external effect is claimed.
 */
export class AuthorizationRelationshipCoordinator {
  constructor(
    private readonly dependencies: {
      store: AuthorizationRelationshipStore;
      gateway: RelationshipTupleGateway;
      clock: { now(): string };
    },
  ) {}

  async submit(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    mutationKey: string;
    actor: PrincipalRef;
    update: AuthorizationRelationshipUpdateInput;
  }): Promise<Outcome> {
    const tupleKey = await relationshipTupleKey({
      organizationId: input.organizationId,
      tuple: input.update.tuple,
    });
    if (Result.isFailure(tupleKey)) {
      return Result.fail(
        new AuthorizationRelationshipRepositoryError(
          "tuple_key_failed",
          false,
          tupleKey.error.message,
        ),
      );
    }
    const prepared = await this.dependencies.store.prepare({
      organizationId: input.organizationId,
      mutationKey: input.mutationKey,
      actionRequestId: input.actionRequestId,
      tupleKey: tupleKey.value,
      tuple: input.update.tuple,
      objectType: input.update.tuple.object.slice(0, input.update.tuple.object.indexOf(":")),
      operation: input.update.operation,
      desiredPresent: input.update.operation === "write",
      actor: input.actor,
      authorizationModelId: this.dependencies.gateway.authorizationModelId,
      requestedAt: this.dependencies.clock.now(),
    });
    if (Result.isFailure(prepared)) return prepared;
    return this.apply(prepared.value.mutation);
  }

  /** Applies one mutation (idempotent; safe to call again for the same key). */
  async apply(target: RelationshipMutationRecord): Promise<Outcome> {
    const { store, gateway, clock } = this.dependencies;
    const loaded = await store.load({
      organizationId: target.organizationId,
      mutationKey: target.mutationKey,
    });
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value) {
      return Result.fail(
        new AuthorizationRelationshipRepositoryError(
          "relationship_mutation_not_found",
          false,
          "mutationが見つかりません",
        ),
      );
    }
    const { mutation, relationship } = loaded.value;
    if (TERMINAL.has(mutation.status)) return Result.succeed({ status: mutation.status, mutation });
    // A stale mutation never reaches the provider. If an earlier attempt of it
    // may have (attemptCount > 0, e.g. response lost), its write could land
    // after the newer revision was confirmed, so the latest is drift-checked.
    if (mutation.revision < relationship.revision) {
      return this.supersede(loaded.value, mutation.attemptCount > 0);
    }

    const applying = await store.markApplying({ mutation, at: clock.now() });
    if (Result.isFailure(applying)) return applying;
    if (applying.value === "not_latest") {
      return this.supersede(loaded.value, mutation.attemptCount > 0);
    }
    if (applying.value === "terminal") return this.reload(mutation);

    const observed = await gateway.read({
      organizationId: mutation.organizationId,
      tuple: mutation.tuple,
    });
    if (Result.isFailure(observed)) return this.indeterminate(mutation, observed.error.code);

    if (observed.value !== mutation.desiredPresent) {
      const applied = await gateway.apply({
        organizationId: mutation.organizationId,
        tuple: mutation.tuple,
        present: mutation.desiredPresent,
      });
      if (Result.isFailure(applied)) {
        if (applied.error.effect !== "rejected" || applied.error.retriable) {
          // Network loss / timeout / 5xx / not sent / 429: the effect is
          // unknown or retriable. Never assume "not applied"; reconcile later.
          return this.indeterminate(mutation, applied.error.code);
        }
        // Permanent rejection (e.g. the tuple changed concurrently, or an
        // invalid tuple). Only confirm if the provider already matches.
        const reread = await gateway.read({
          organizationId: mutation.organizationId,
          tuple: mutation.tuple,
        });
        if (Result.isFailure(reread)) return this.indeterminate(mutation, reread.error.code);
        if (reread.value !== mutation.desiredPresent) {
          const failed = await store.markFailed({
            mutation,
            errorCode: applied.error.code,
            at: clock.now(),
          });
          if (Result.isFailure(failed)) return failed;
          return this.reload(mutation, applied.error.code);
        }
      }
    }

    // Phase 3: confirm only on observed effect.
    const confirmedState = await gateway.read({
      organizationId: mutation.organizationId,
      tuple: mutation.tuple,
    });
    if (Result.isFailure(confirmedState)) {
      return this.indeterminate(mutation, confirmedState.error.code);
    }
    if (confirmedState.value !== mutation.desiredPresent) {
      return this.indeterminate(mutation, "provider_state_mismatch");
    }
    const confirmed = await store.markConfirmed({
      mutation,
      observedPresent: confirmedState.value,
      at: clock.now(),
    });
    if (Result.isFailure(confirmed)) return confirmed;
    if (confirmed.value === "not_latest") {
      // A newer revision was prepared while this one was in flight. Our
      // provider write may have landed after it; converge to the latest.
      return this.supersede(loaded.value, true);
    }
    return this.reload(mutation);
  }

  /**
   * Converges one tuple to its latest desired revision: supersedes stale open
   * mutations (no provider call), applies the latest if still open, and
   * repairs provider drift of an already-confirmed latest revision.
   */
  async reconcileTuple(input: {
    organizationId: OrganizationId;
    tupleKey: string;
  }): Result.ResultAsync<
    RelationshipMutationOutcome | null,
    AuthorizationRelationshipRepositoryError
  > {
    const { store, gateway, clock } = this.dependencies;
    const superseded = await store.supersedeStale({ ...input, at: clock.now() });
    if (Result.isFailure(superseded)) return superseded;
    const latest = await store.loadLatest(input);
    if (Result.isFailure(latest)) return latest;
    if (!latest.value) return Result.succeed(null);
    const { mutation } = latest.value;
    if (mutation.status === "failed" || mutation.status === "superseded") {
      return Result.succeed({ status: mutation.status, mutation });
    }
    if (mutation.status !== "confirmed") return this.apply(mutation);

    const observed = await gateway.read({
      organizationId: input.organizationId,
      tuple: mutation.tuple,
    });
    if (Result.isFailure(observed)) return Result.succeed({ status: mutation.status, mutation });
    if (observed.value === mutation.desiredPresent) {
      return Result.succeed({ status: mutation.status, mutation });
    }
    const repaired = await gateway.apply({
      organizationId: input.organizationId,
      tuple: mutation.tuple,
      present: mutation.desiredPresent,
    });
    if (Result.isFailure(repaired)) {
      return Result.succeed({ status: mutation.status, mutation, errorCode: repaired.error.code });
    }
    const verified = await gateway.read({
      organizationId: input.organizationId,
      tuple: mutation.tuple,
    });
    if (Result.isFailure(verified) || verified.value !== mutation.desiredPresent) {
      return Result.succeed({
        status: mutation.status,
        mutation,
        errorCode: "drift_repair_unverified",
      });
    }
    const recorded = await store.recordDriftRepaired({ mutation, at: clock.now() });
    if (Result.isFailure(recorded)) return recorded;
    return Result.succeed({ status: mutation.status, mutation });
  }

  /** Scheduled / manual reconciler entry point. */
  async reconcilePending(input: {
    organizationId: OrganizationId;
    graceMs?: number;
    limit?: number;
  }): Result.ResultAsync<
    { reconciled: number; outcomes: Array<{ tupleKey: string; status: string | null }> },
    AuthorizationRelationshipRepositoryError
  > {
    const now = Date.parse(this.dependencies.clock.now());
    const pending = await this.dependencies.store.listReconcilable({
      organizationId: input.organizationId,
      idleBefore: new Date(now - (input.graceMs ?? 60_000)).toISOString(),
      limit: input.limit ?? 25,
    });
    if (Result.isFailure(pending)) return pending;
    const outcomes: Array<{ tupleKey: string; status: string | null }> = [];
    for (const tuple of pending.value) {
      const reconciled = await this.reconcileTuple(tuple);
      if (Result.isFailure(reconciled)) return reconciled;
      outcomes.push({ tupleKey: tuple.tupleKey, status: reconciled.value?.status ?? null });
    }
    return Result.succeed({ reconciled: outcomes.length, outcomes });
  }

  private async supersede(
    loaded: LoadedRelationshipMutation,
    reconcileLatest: boolean,
  ): Promise<Outcome> {
    const superseded = await this.dependencies.store.supersedeStale({
      organizationId: loaded.mutation.organizationId,
      tupleKey: loaded.mutation.tupleKey,
      at: this.dependencies.clock.now(),
    });
    if (Result.isFailure(superseded)) return superseded;
    if (reconcileLatest) {
      const reconciled = await this.reconcileTuple({
        organizationId: loaded.mutation.organizationId,
        tupleKey: loaded.mutation.tupleKey,
      });
      if (Result.isFailure(reconciled)) return reconciled;
    }
    return this.reload(loaded.mutation);
  }

  private async indeterminate(
    mutation: RelationshipMutationRecord,
    errorCode: string,
  ): Promise<Outcome> {
    const marked = await this.dependencies.store.markIndeterminate({
      mutation,
      errorCode,
      at: this.dependencies.clock.now(),
    });
    if (Result.isFailure(marked)) return marked;
    return this.reload(mutation, errorCode);
  }

  private async reload(mutation: RelationshipMutationRecord, errorCode?: string): Promise<Outcome> {
    const loaded = await this.dependencies.store.load({
      organizationId: mutation.organizationId,
      mutationKey: mutation.mutationKey,
    });
    if (Result.isFailure(loaded)) return loaded;
    const current = loaded.value?.mutation ?? mutation;
    return Result.succeed({
      status: current.status,
      mutation: current,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

/**
 * ActionExecutor for `authorization.relationship.update` (executorKey
 * `authorization`). Runs after Authorization, Approval and Re-Authorization of
 * the normal ActionRequest pipeline. Validation is repeated here (defense in
 * depth): only Managed Relationship Catalog tuples on the tenant's
 * `authorization_admin:root` resource are accepted.
 *
 * The execution idempotency key is the mutation key, so a retried execution
 * reuses the same revision. `executed` means the intent is durably recorded;
 * `output.relationship.effectConfirmed` says whether the provider effect was
 * observed.
 */
export class AuthorizationRelationshipExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  constructor(
    private readonly coordinator: AuthorizationRelationshipCoordinator,
    private readonly catalog: ManagedRelationshipCatalog = DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
  ) {}

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    if (!request.actor) {
      return Result.fail(
        new ActionExecutorError({
          code: "relationship_actor_missing",
          retriable: false,
          detail: "relationship mutationにはtrusted actorが必要です",
        }),
      );
    }
    if (
      String(request.action.resource.type) !== AUTHORIZATION_ADMIN_OBJECT_TYPE ||
      String(request.action.resource.id) !== AUTHORIZATION_ADMIN_ROOT_ID
    ) {
      return Result.fail(
        new ActionExecutorError({
          code: "invalid_relationship_resource",
          retriable: false,
          detail: "resourceはauthorization_admin:rootである必要があります",
        }),
      );
    }
    const validated = validateRelationshipUpdateInput(request.action.input, this.catalog);
    if (validated.type === "invalid") {
      return Result.fail(
        new ActionExecutorError({
          code: "invalid_relationship_update",
          retriable: false,
          detail: validated.issues.map((issue) => `${issue.path}: ${issue.code}`).join("; "),
        }),
      );
    }
    const outcome = await this.coordinator.submit({
      organizationId: request.organizationId,
      actionRequestId: request.actionRequestId,
      mutationKey: request.idempotencyKey,
      actor: request.actor,
      update: validated.input,
    });
    if (Result.isFailure(outcome)) {
      return Result.fail(
        new ActionExecutorError({
          code: outcome.error.code,
          retriable: outcome.error.retriable,
          detail: outcome.error.message,
        }),
      );
    }
    const { status, mutation, errorCode } = outcome.value;
    if (status === "failed") {
      return Result.fail(
        new ActionExecutorError({
          code: "relationship_mutation_failed",
          retriable: false,
          detail: `provider rejected the relationship mutation (${errorCode ?? mutation.lastErrorCode ?? "unknown"})`,
          details: {
            mutationKey: mutation.mutationKey,
            revision: mutation.revision,
            errorCode: errorCode ?? mutation.lastErrorCode ?? null,
          },
        }),
      );
    }
    return Result.succeed({
      status: "succeeded",
      output: {
        relationship: {
          mutationKey: mutation.mutationKey,
          tupleKey: mutation.tupleKey,
          revision: mutation.revision,
          operation: mutation.operation,
          desiredState: mutation.desiredPresent ? "present" : "absent",
          status,
          effectConfirmed: status === "confirmed",
          ...(errorCode ? { errorCode } : {}),
        },
      },
    });
  }
}
