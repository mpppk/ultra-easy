import { Result } from "@praha/byethrow";

import {
  ActionRequestDependencyError,
  type VersionedPolicyBindingResolver,
} from "@app/approval-application";
import {
  GovernancePersistenceError,
  resolvePolicyBindings,
  type ActionDefinition,
  type ActionDefinitionResolver,
  type ActionType,
  type ApprovalPolicyBinding,
  type ApprovalPolicyDefinition,
  type GovernancePersistence,
  type OrganizationId,
  type PolicyEvaluationContext,
  type PrincipalRef,
  type VersionedApprovalPolicyBinding,
} from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

type ActionDefinitionRow = {
  definition_json: string;
};

type PolicyRow = {
  version: number;
  policy_json: string;
};

type BindingRow = {
  binding_json: string;
};

type ForceCancelAuditRow = {
  target_action_request_id: string;
  actor_json: string;
  reason: string;
  occurred_at: string;
  post_review_required: number;
};

function persistenceError(
  code: string,
  retriable: boolean,
  error: unknown,
  fallback: string,
): GovernancePersistenceError {
  return new GovernancePersistenceError(
    code,
    retriable,
    error instanceof Error ? error.message : fallback,
  );
}

async function run(statement: D1PreparedStatementLike) {
  try {
    const result = await statement.run();
    if (!result.success) {
      return Result.fail(
        persistenceError(
          "governance_repository_error",
          true,
          result.error,
          "Governance writeに失敗しました",
        ),
      );
    }
    return Result.succeed(result);
  } catch (error) {
    return Result.fail(
      persistenceError("governance_repository_error", true, error, "Governance writeに失敗しました"),
    );
  }
}

async function first<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T | null, GovernancePersistenceError> {
  try {
    return Result.succeed(await statement.first<T>()) as Result.Result<
      T | null,
      GovernancePersistenceError
    >;
  } catch (error) {
    return Result.fail(
      persistenceError("governance_repository_error", true, error, "Governance readに失敗しました"),
    );
  }
}

async function all<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], GovernancePersistenceError> {
  if (!statement.all) {
    return Result.fail(
      new GovernancePersistenceError("d1_all_not_supported", false, "D1 all()が利用できません"),
    );
  }
  try {
    const rows = await statement.all<T>();
    return Result.succeed(rows.results) as Result.Result<T[], GovernancePersistenceError>;
  } catch (error) {
    return Result.fail(
      persistenceError("governance_repository_error", true, error, "Governance rows取得に失敗しました"),
    );
  }
}

function parse<T>(value: string): Result.Result<T, GovernancePersistenceError> {
  try {
    return Result.succeed(JSON.parse(value) as T) as Result.Result<T, GovernancePersistenceError>;
  } catch (error) {
    return Result.fail(
      persistenceError("governance_json_invalid", false, error, "Governance JSONが不正です"),
    );
  }
}

function json(value: unknown): Result.Result<string, GovernancePersistenceError> {
  try {
    return Result.succeed(JSON.stringify(value));
  } catch (error) {
    return Result.fail(
      persistenceError("governance_json_invalid", false, error, "Governance JSONをserializeできません"),
    );
  }
}

export class D1GovernanceRepository implements GovernancePersistence {
  constructor(private readonly db: D1DatabaseLike) {}

  async publishActionDefinition(
    input: Parameters<GovernancePersistence["publishActionDefinition"]>[0],
  ): Result.ResultAsync<void, GovernancePersistenceError> {
    const definitionJson = json(input.definition);
    const actorJson = json(input.actor);
    if (Result.isFailure(definitionJson)) return definitionJson;
    if (Result.isFailure(actorJson)) return actorJson;

    const inserted = await run(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO published_action_definitions (
             organization_id, definition_key, version, action_type, definition_json,
             actor_json, source_action_request_id, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.organizationId,
          input.definition.key,
          input.definition.version,
          input.definition.actionType,
          definitionJson.value,
          actorJson.value,
          input.sourceActionRequestId,
          input.occurredAt,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if ((inserted.value.meta?.changes ?? 0) > 0) return Result.succeed(undefined);

    const existing = await first<ActionDefinitionRow>(
      this.db
        .prepare(
          `SELECT definition_json
             FROM published_action_definitions
            WHERE organization_id = ? AND definition_key = ? AND version = ?`,
        )
        .bind(input.organizationId, input.definition.key, input.definition.version),
    );
    if (Result.isFailure(existing)) return existing;
    return existing.value?.definition_json === definitionJson.value
      ? Result.succeed(undefined)
      : Result.fail(
          new GovernancePersistenceError(
            "action_definition_version_conflict",
            false,
            "同じAction Definition key/versionへ異なる内容をpublishできません",
          ),
        );
  }

  async publishApprovalPolicy(
    input: Parameters<GovernancePersistence["publishApprovalPolicy"]>[0],
  ): Result.ResultAsync<void, GovernancePersistenceError> {
    const policyJson = json(input.policy);
    const actorJson = json(input.actor);
    if (Result.isFailure(policyJson)) return policyJson;
    if (Result.isFailure(actorJson)) return actorJson;

    const inserted = await run(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO published_approval_policy_versions (
             organization_id, policy_key, version, policy_json, actor_json,
             source_action_request_id, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.organizationId,
          input.policy.key,
          input.version,
          policyJson.value,
          actorJson.value,
          input.sourceActionRequestId,
          input.occurredAt,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if ((inserted.value.meta?.changes ?? 0) > 0) return Result.succeed(undefined);

    const existing = await first<PolicyRow>(
      this.db
        .prepare(
          `SELECT version, policy_json
             FROM published_approval_policy_versions
            WHERE organization_id = ? AND policy_key = ? AND version = ?`,
        )
        .bind(input.organizationId, input.policy.key, input.version),
    );
    if (Result.isFailure(existing)) return existing;
    return existing.value?.policy_json === policyJson.value
      ? Result.succeed(undefined)
      : Result.fail(
          new GovernancePersistenceError(
            "approval_policy_version_conflict",
            false,
            "同じApproval Policy key/versionへ異なる内容をpublishできません",
          ),
        );
  }

  async updateApprovalPolicyBinding(
    input: Parameters<GovernancePersistence["updateApprovalPolicyBinding"]>[0],
  ): Result.ResultAsync<void, GovernancePersistenceError> {
    const bindingJson = json(input.binding);
    const actorJson = json(input.actor);
    if (Result.isFailure(bindingJson)) return bindingJson;
    if (Result.isFailure(actorJson)) return actorJson;

    const saved = await run(
      this.db
        .prepare(
          `INSERT INTO approval_policy_bindings (
             organization_id, binding_id, policy_key, enabled, binding_json,
             actor_json, source_action_request_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(organization_id, binding_id) DO UPDATE SET
             policy_key = excluded.policy_key,
             enabled = excluded.enabled,
             binding_json = excluded.binding_json,
             actor_json = excluded.actor_json,
             source_action_request_id = excluded.source_action_request_id,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.organizationId,
          input.binding.id,
          input.binding.policyKey,
          input.binding.enabled ? 1 : 0,
          bindingJson.value,
          actorJson.value,
          input.sourceActionRequestId,
          input.occurredAt,
        ),
    );
    return Result.isFailure(saved) ? saved : Result.succeed(undefined);
  }

  async recordForceCancel(
    input: Parameters<GovernancePersistence["recordForceCancel"]>[0],
  ): Result.ResultAsync<void, GovernancePersistenceError> {
    const actorJson = json(input.actor);
    if (Result.isFailure(actorJson)) return actorJson;

    const inserted = await run(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO force_cancel_audit (
             organization_id, source_action_request_id, target_action_request_id,
             actor_json, reason, occurred_at, post_review_required
           ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          input.organizationId,
          input.sourceActionRequestId,
          input.targetActionRequestId,
          actorJson.value,
          input.reason,
          input.occurredAt,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if ((inserted.value.meta?.changes ?? 0) > 0) return Result.succeed(undefined);

    const existing = await this.loadForceCancelAudit({
      organizationId: input.organizationId,
      sourceActionRequestId: input.sourceActionRequestId,
    });
    if (Result.isFailure(existing)) return existing;
    if (
      existing.value &&
      existing.value.targetActionRequestId === String(input.targetActionRequestId) &&
      existing.value.reason === input.reason
    ) {
      return Result.succeed(undefined);
    }
    return Result.fail(
      new GovernancePersistenceError(
        "force_cancel_audit_conflict",
        false,
        "同じsource ActionRequest IDへ異なるforce cancel auditを保存できません",
      ),
    );
  }

  async loadForceCancelAudit(input: {
    organizationId: OrganizationId;
    sourceActionRequestId: string;
  }): Result.ResultAsync<
    | {
        targetActionRequestId: string;
        actor: PrincipalRef;
        reason: string;
        occurredAt: string;
        postReviewRequired: true;
      }
    | null,
    GovernancePersistenceError
  > {
    const row = await first<ForceCancelAuditRow>(
      this.db
        .prepare(
          `SELECT target_action_request_id, actor_json, reason, occurred_at, post_review_required
             FROM force_cancel_audit
            WHERE organization_id = ? AND source_action_request_id = ?`,
        )
        .bind(input.organizationId, input.sourceActionRequestId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const actor = parse<PrincipalRef>(row.value.actor_json);
    if (Result.isFailure(actor)) return actor;
    return Result.succeed({
      targetActionRequestId: row.value.target_action_request_id,
      actor: actor.value,
      reason: row.value.reason,
      occurredAt: row.value.occurred_at,
      postReviewRequired: true,
    });
  }
}

export class D1PublishedActionDefinitionResolver implements ActionDefinitionResolver {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly organizationId: OrganizationId,
  ) {}

  async resolve(actionType: ActionType): Promise<ActionDefinition> {
    const row = await this.db
      .prepare(
        `SELECT definition_json
           FROM published_action_definitions
          WHERE organization_id = ? AND action_type = ?
          ORDER BY version DESC
          LIMIT 1`,
      )
      .bind(this.organizationId, actionType)
      .first<ActionDefinitionRow>();
    if (!row) {
      return Promise.reject(
        new Error(`Published Action Definitionが見つかりません: ${String(actionType)}`),
      );
    }
    return JSON.parse(row.definition_json) as ActionDefinition;
  }
}

export class D1PublishedPolicyBindingResolver implements VersionedPolicyBindingResolver {
  constructor(private readonly db: D1DatabaseLike) {}

  async resolve(input: {
    context: PolicyEvaluationContext;
    actionDefinition: ActionDefinition;
  }): Result.ResultAsync<readonly VersionedApprovalPolicyBinding[], ActionRequestDependencyError> {
    const rows = await all<BindingRow>(
      this.db
        .prepare(
          `SELECT binding_json
             FROM approval_policy_bindings
            WHERE organization_id = ? AND enabled = 1
            ORDER BY binding_id`,
        )
        .bind(input.context.organization.id),
    );
    if (Result.isFailure(rows)) {
      return Result.fail(
        new ActionRequestDependencyError(
          rows.error.code,
          rows.error.retriable,
          rows.error.message,
          rows.error,
        ),
      );
    }

    const bindings: ApprovalPolicyBinding[] = [];
    for (const row of rows.value) {
      const parsed = parse<ApprovalPolicyBinding>(row.binding_json);
      if (Result.isFailure(parsed)) {
        return Result.fail(
          new ActionRequestDependencyError(
            parsed.error.code,
            parsed.error.retriable,
            parsed.error.message,
            parsed.error,
          ),
        );
      }
      bindings.push(parsed.value);
    }

    const applicable = resolvePolicyBindings(bindings, input.context);
    if (Result.isFailure(applicable)) {
      return Result.fail(
        new ActionRequestDependencyError(
          applicable.error.code,
          false,
          applicable.error.message,
          applicable.error,
        ),
      );
    }

    const result: VersionedApprovalPolicyBinding[] = [];
    for (const binding of applicable.value) {
      const policyRow = await first<PolicyRow>(
        this.db
          .prepare(
            `SELECT version, policy_json
               FROM published_approval_policy_versions
              WHERE organization_id = ? AND policy_key = ?
              ORDER BY version DESC
              LIMIT 1`,
          )
          .bind(input.context.organization.id, binding.policyKey),
      );
      if (Result.isFailure(policyRow)) {
        return Result.fail(
          new ActionRequestDependencyError(
            policyRow.error.code,
            policyRow.error.retriable,
            policyRow.error.message,
            policyRow.error,
          ),
        );
      }
      if (!policyRow.value) {
        return Result.fail(
          new ActionRequestDependencyError(
            "published_policy_not_found",
            false,
            `Binding参照先のPublished Policyが見つかりません: ${String(binding.policyKey)}`,
          ),
        );
      }
      const policy = parse<ApprovalPolicyDefinition>(policyRow.value.policy_json);
      if (Result.isFailure(policy)) {
        return Result.fail(
          new ActionRequestDependencyError(
            policy.error.code,
            policy.error.retriable,
            policy.error.message,
            policy.error,
          ),
        );
      }
      result.push({
        binding,
        policyVersion: policyRow.value.version,
        policy: policy.value,
      });
    }

    return Result.succeed(result);
  }
}
