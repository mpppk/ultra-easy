import { Result } from "@praha/byethrow";

import type { ActionDefinition } from "./action-definition.ts";
import {
  ActionExecutorError,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
} from "./action-execution.ts";
import type {
  ActionDefinitionKey,
  ActionRequestId,
  ActionType,
  ExecutorKey,
  OrganizationId,
  SchemaKey,
} from "./domain/brand.ts";
import type { ApprovalPolicyBinding, ApprovalPolicyDefinition } from "./domain/policy.ts";
import type { PrincipalRef } from "./domain/principal.ts";
import {
  validateApprovalPolicyBindingSemantics,
  validateApprovalPolicySemantics,
} from "./semantic-validator.ts";

export const GOVERNANCE_ACTION_TYPES = {
  actionDefinitionPublish: "action_definition.publish" as ActionType,
  approvalPolicyPublish: "approval_policy.publish" as ActionType,
  approvalPolicyBindingUpdate: "approval_policy_binding.update" as ActionType,
  adminForceCancel: "admin.force_cancel" as ActionType,
} as const;

export const GOVERNANCE_EXECUTOR_KEY = "governance" as ExecutorKey;

const schema = (key: string) => ({ key: key as SchemaKey, version: 1 });

/**
 * Bootstrap installs these definitions once. Thereafter changes to the
 * definitions themselves are submitted through action_definition.publish.
 */
export const GOVERNANCE_ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  {
    key: "governance:action-definition-publish" as ActionDefinitionKey,
    version: 1,
    actionType: GOVERNANCE_ACTION_TYPES.actionDefinitionPublish,
    inputSchema: schema("governance:action-definition-publish"),
    executorKey: GOVERNANCE_EXECUTOR_KEY,
  },
  {
    key: "governance:approval-policy-publish" as ActionDefinitionKey,
    version: 1,
    actionType: GOVERNANCE_ACTION_TYPES.approvalPolicyPublish,
    inputSchema: schema("governance:approval-policy-publish"),
    executorKey: GOVERNANCE_EXECUTOR_KEY,
  },
  {
    key: "governance:approval-policy-binding-update" as ActionDefinitionKey,
    version: 1,
    actionType: GOVERNANCE_ACTION_TYPES.approvalPolicyBindingUpdate,
    inputSchema: schema("governance:approval-policy-binding-update"),
    executorKey: GOVERNANCE_EXECUTOR_KEY,
  },
  {
    key: "governance:admin-force-cancel" as ActionDefinitionKey,
    version: 1,
    actionType: GOVERNANCE_ACTION_TYPES.adminForceCancel,
    inputSchema: schema("governance:admin-force-cancel"),
    executorKey: GOVERNANCE_EXECUTOR_KEY,
  },
];

export class GovernancePersistenceError extends Error {
  readonly name = "GovernancePersistenceError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type GovernanceWriteContext = {
  organizationId: OrganizationId;
  sourceActionRequestId: ActionRequestId;
  actor: PrincipalRef;
  occurredAt: string;
};

export interface GovernancePersistence {
  publishActionDefinition(
    input: GovernanceWriteContext & {
      definition: ActionDefinition;
    },
  ): Result.ResultAsync<void, GovernancePersistenceError>;

  publishApprovalPolicy(
    input: GovernanceWriteContext & {
      version: number;
      policy: ApprovalPolicyDefinition;
    },
  ): Result.ResultAsync<void, GovernancePersistenceError>;

  updateApprovalPolicyBinding(
    input: GovernanceWriteContext & {
      binding: ApprovalPolicyBinding;
    },
  ): Result.ResultAsync<void, GovernancePersistenceError>;

  recordForceCancel(
    input: GovernanceWriteContext & {
      targetActionRequestId: ActionRequestId;
      reason: string;
      postReviewRequired: true;
    },
  ): Result.ResultAsync<void, GovernancePersistenceError>;
}

export class WorkflowCancellationError extends Error {
  readonly name = "WorkflowCancellationError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowCancellationControl {
  cancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    cancelledAt: string;
  }): Result.ResultAsync<{ duplicate: boolean }, WorkflowCancellationError>;
}

function fail(code: string, detail: string, retriable = false) {
  return Result.fail(
    new ActionExecutorError({
      code,
      retriable,
      detail,
    }),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireActor(
  request: ActionExecutionRequest,
): Result.Result<PrincipalRef, ActionExecutorError> {
  return request.actor
    ? Result.succeed(request.actor)
    : fail("governance_actor_missing", "Governance actionにはtrusted actorが必要です");
}

function occurredAt(request: ActionExecutionRequest): string {
  return request.authorizationEvidence.evaluatedAt;
}

function wrapPersistence(error: GovernancePersistenceError) {
  return new ActionExecutorError({
    code: error.code,
    retriable: error.retriable,
    detail: error.message,
    cause: error,
  });
}

function wrapCancellation(error: WorkflowCancellationError) {
  return new ActionExecutorError({
    code: error.code,
    retriable: error.retriable,
    detail: error.message,
    cause: error,
  });
}

export class GovernanceActionExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  constructor(
    private readonly persistence: GovernancePersistence,
    private readonly cancellation: WorkflowCancellationControl,
  ) {}

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const actor = requireActor(request);
    if (Result.isFailure(actor)) return actor;

    const input = record(request.action.input);
    if (!input)
      return fail(
        "invalid_governance_input",
        "Governance action inputはobjectである必要があります",
      );

    const context: GovernanceWriteContext = {
      organizationId: request.organizationId,
      sourceActionRequestId: request.actionRequestId,
      actor: actor.value,
      occurredAt: occurredAt(request),
    };

    switch (String(request.action.type)) {
      case String(GOVERNANCE_ACTION_TYPES.actionDefinitionPublish): {
        const definition = record(input.definition) as ActionDefinition | null;
        if (
          !definition ||
          typeof definition.actionType !== "string" ||
          typeof definition.key !== "string" ||
          typeof definition.executorKey !== "string" ||
          !Number.isSafeInteger(definition.version) ||
          definition.version < 1
        ) {
          return fail("invalid_action_definition", "publishするAction Definitionが不正です");
        }
        const published = await this.persistence.publishActionDefinition({
          ...context,
          definition,
        });
        if (Result.isFailure(published)) return Result.fail(wrapPersistence(published.error));
        return Result.succeed({
          status: "succeeded",
          output: {
            actionType: String(definition.actionType),
            version: definition.version,
          },
        });
      }

      case String(GOVERNANCE_ACTION_TYPES.approvalPolicyPublish): {
        const version = input.version;
        const policy = record(input.policy) as ApprovalPolicyDefinition | null;
        if (!Number.isSafeInteger(version) || (version as number) < 1 || !policy) {
          return fail("invalid_approval_policy", "policy version/definitionが不正です");
        }
        const validation = validateApprovalPolicySemantics(policy);
        if (!validation.valid) {
          return fail(
            "invalid_approval_policy",
            validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
          );
        }
        const published = await this.persistence.publishApprovalPolicy({
          ...context,
          version: version as number,
          policy,
        });
        if (Result.isFailure(published)) return Result.fail(wrapPersistence(published.error));
        return Result.succeed({
          status: "succeeded",
          output: { policyKey: String(policy.key), version: version as number },
        });
      }

      case String(GOVERNANCE_ACTION_TYPES.approvalPolicyBindingUpdate): {
        const binding = record(input.binding) as ApprovalPolicyBinding | null;
        if (!binding || String(binding.organizationId) !== String(request.organizationId)) {
          return fail(
            "invalid_approval_policy_binding",
            "binding.organizationIdはActionRequestのorganizationと一致する必要があります",
          );
        }
        const validation = validateApprovalPolicyBindingSemantics(binding);
        if (!validation.valid) {
          return fail(
            "invalid_approval_policy_binding",
            validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
          );
        }
        const updated = await this.persistence.updateApprovalPolicyBinding({ ...context, binding });
        if (Result.isFailure(updated)) return Result.fail(wrapPersistence(updated.error));
        return Result.succeed({
          status: "succeeded",
          output: { bindingId: String(binding.id), enabled: binding.enabled },
        });
      }

      case String(GOVERNANCE_ACTION_TYPES.adminForceCancel): {
        const target = input.targetActionRequestId;
        const reason = input.reason;
        if (typeof target !== "string" || target.length === 0) {
          return fail("force_cancel_target_required", "targetActionRequestIdは必須です");
        }
        if (typeof reason !== "string" || reason.trim().length === 0) {
          return fail("force_cancel_reason_required", "force cancelには理由が必要です");
        }
        const targetActionRequestId = target as ActionRequestId;
        const cancelled = await this.cancellation.cancel({
          organizationId: request.organizationId,
          actionRequestId: targetActionRequestId,
          cancelledAt: context.occurredAt,
        });
        if (Result.isFailure(cancelled)) return Result.fail(wrapCancellation(cancelled.error));

        const audited = await this.persistence.recordForceCancel({
          ...context,
          targetActionRequestId,
          reason: reason.trim(),
          postReviewRequired: true,
        });
        if (Result.isFailure(audited)) return Result.fail(wrapPersistence(audited.error));

        return Result.succeed({
          status: "succeeded",
          output: {
            targetActionRequestId: target,
            duplicate: cancelled.value.duplicate,
            postReviewRequired: true,
          },
        });
      }

      default:
        return fail(
          "unsupported_governance_action",
          `Governance executorが未対応のaction typeです: ${String(request.action.type)}`,
        );
    }
  }
}
