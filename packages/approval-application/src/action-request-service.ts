import { Result } from "@praha/byethrow";

import {
  actionEventRecord,
  actionPlanAuditEvents,
  ActionAuthorizationCheckFailedError,
  ActionExecutorError,
  authorizeActionRequest,
  canonicalizeJson,
  createActionExecutionIdempotencyKey,
  evaluateApprovalPlan,
  executeActionRequest,
  materializeApprovalPlan,
  validateActionInput,
  verifyMaterializedApprovalPlan,
} from "@app/approval-core";
import type {
  Action,
  ActionAuthorizer,
  ActionEventRecord,
  ActionEventRepository,
  ApprovalPlanEvaluation,
  ActionDefinition,
  ActionDefinitionResolver,
  ActionExecutor,
  ActionRequest,
  ActionRequestId,
  AuthorizationEvidence,
  JsonValue,
  MaterializedApprovalPlan,
  MaterializedPlanRepository,
  OrganizationId,
  PolicyEvaluationContext,
  PolicyEvaluationOrganization,
  PrincipalRef,
  SchemaResolver,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";

import type {
  ActionRequestDependencyError,
  ActionRequestIdGenerator,
  ActionWorkflowStarter,
  VersionedPolicyBindingResolver,
} from "./ports.ts";

export type TrustedActionRequestContext = {
  actor: PrincipalRef;
  authority: ActionRequest["authority"];
  origin: ActionRequest["origin"];
  organization: PolicyEvaluationOrganization;
  attributes?: Record<string, JsonValue>;
  now: string;
};

export type ActionRequestPublicStatus =
  | "evaluating"
  | "pending_approval"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "authorization_revoked"
  | "authorization_check_failed"
  | "execution_failed";

export type ActionRequestView = {
  id: string;
  organizationId: string;
  actor: PrincipalRef;
  authorityPrincipal: PrincipalRef;
  caller?: PrincipalRef;
  action: Action;
  origin: ActionRequest["origin"]["type"];
  status: ActionRequestPublicStatus;
  approval: {
    required: boolean;
    activeTaskCount?: number;
    completedTaskCount?: number;
  };
  result?: {
    status:
      | "executed"
      | "authorization_revoked"
      | "authorization_check_failed"
      | "execution_failed";
    output?: JsonValue;
    code?: string;
    message?: string;
  };
  checksums: {
    actionFingerprint: string;
    evaluationSnapshotChecksum: string;
    approvalPlanChecksum: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ActionRequestEvaluation =
  | {
      type: "evaluated";
      actionRequestId: ActionRequestId;
      request: ActionRequest;
      context: PolicyEvaluationContext;
      actionDefinition: ActionDefinition;
      bindings: readonly VersionedApprovalPolicyBinding[];
      policyEvaluation: ApprovalPlanEvaluation;
      authorizationEvidence: AuthorizationEvidence;
      plan: MaterializedApprovalPlan;
    }
  | {
      type: "authorization_denied";
      actionRequestId: ActionRequestId;
      code: string;
      reason: string;
    };

export type ActionRequestSubmitResult =
  | {
      type: "accepted";
      actionRequestId: ActionRequestId;
      request: ActionRequest;
      plan: MaterializedApprovalPlan;
      view: ActionRequestView;
      workflowInstanceId?: string;
    }
  | {
      type: "authorization_denied";
      actionRequestId: ActionRequestId;
      code: string;
      reason: string;
    };

/**
 * `prepare` が1回の評価で確定したActionRequest。JSON serializableで、
 * adapterはadmission / crash recoveryのためにこれを永続化してから `commit` できる。
 */
export type PreparedActionRequest = {
  actionRequestId: ActionRequestId;
  organizationId: OrganizationId;
  request: ActionRequest;
  plan: MaterializedApprovalPlan;
  authorizationEvidence: AuthorizationEvidence;
  /** prepared planのflowがnone以外か。admission判断用で、callerに委ねない。 */
  approvalRequired: boolean;
  preparedAt: string;
};

export type ActionRequestPreparation =
  | { type: "prepared"; prepared: PreparedActionRequest }
  | {
      type: "authorization_denied";
      actionRequestId: ActionRequestId;
      organizationId: OrganizationId;
      code: string;
      reason: string;
      deniedAt: string;
    };

export type ActionRequestApplicationErrorCode =
  | "action_definition_resolution_failed"
  | "schema_resolution_failed"
  | "action_input_validation_failed"
  | "action_input_not_object"
  | "authorization_provider_failed"
  | "policy_binding_resolution_failed"
  | "policy_evaluation_failed"
  | "materialization_failed"
  | "plan_persistence_failed"
  | "audit_persistence_failed"
  | "action_request_already_exists"
  | "workflow_start_failed"
  | "execution_failed"
  | "prepared_action_request_invalid";

export type ActionRequestValidationIssue = {
  message: string;
  path?: string;
};

export class ActionRequestApplicationError extends Error {
  readonly name = "ActionRequestApplicationError";

  constructor(
    readonly code: ActionRequestApplicationErrorCode,
    readonly retriable: boolean,
    message: string,
    /** Structured schema validation issues (input validation failures only). */
    readonly issues?: readonly ActionRequestValidationIssue[],
    /** immediate executionでActionExecutorが返したerror code（execution_failedのみ）。 */
    readonly executionErrorCode?: string,
  ) {
    super(message);
  }
}

function issuePath(path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined): string {
  return (path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null ? String(segment.key) : String(segment),
    )
    .join(".");
}

export type ActionRequestApplicationServiceDependencies = {
  actionDefinitionResolver: ActionDefinitionResolver;
  schemaResolver: SchemaResolver;
  policyBindingResolver: VersionedPolicyBindingResolver;
  authorizer: ActionAuthorizer;
  executor: ActionExecutor;
  planRepository: MaterializedPlanRepository;
  eventRepository?: ActionEventRepository;
  workflowStarter: ActionWorkflowStarter;
  idGenerator: ActionRequestIdGenerator;
};

const resolveActionDefinition = Result.fn({
  try: async (input: {
    resolver: ActionDefinitionResolver;
    action: Action;
  }): Promise<ActionDefinition> => input.resolver.resolve(input.action.type),
  catch: (error): ActionRequestApplicationError =>
    new ActionRequestApplicationError(
      "action_definition_resolution_failed",
      true,
      error instanceof Error ? error.message : "Action Definitionの解決に失敗しました",
    ),
});

const resolveSchema = Result.fn({
  try: async (input: { resolver: SchemaResolver; definition: ActionDefinition }) =>
    input.resolver.resolve(input.definition.inputSchema),
  catch: (error): ActionRequestApplicationError =>
    new ActionRequestApplicationError(
      "schema_resolution_failed",
      true,
      error instanceof Error ? error.message : "Action input schemaの解決に失敗しました",
    ),
});

const validateSchema = Result.fn({
  try: async (input: { schema: Awaited<ReturnType<SchemaResolver["resolve"]>>; value: unknown }) =>
    validateActionInput(input.schema, input.value),
  catch: (error): ActionRequestApplicationError =>
    new ActionRequestApplicationError(
      "action_input_validation_failed",
      false,
      error instanceof Error ? error.message : "Action inputのvalidationに失敗しました",
    ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapDependencyError(
  error: ActionRequestDependencyError,
  code: "policy_binding_resolution_failed" | "workflow_start_failed",
): ActionRequestApplicationError {
  return new ActionRequestApplicationError(code, error.retriable, error.message);
}

function planPersistenceError(
  result: Exclude<Awaited<ReturnType<MaterializedPlanRepository["save"]>>, { type: "created" }>,
): ActionRequestApplicationError {
  if (result.type === "existing" || result.type === "conflict") {
    return new ActionRequestApplicationError(
      "action_request_already_exists",
      false,
      "同じActionRequest IDのPlanが既に保存されています",
    );
  }
  return new ActionRequestApplicationError(
    "plan_persistence_failed",
    result.type === "repository_error",
    result.message,
  );
}

async function appendAudit(
  repository: ActionEventRepository | undefined,
  records: readonly ActionEventRecord[],
): Result.ResultAsync<void, ActionRequestApplicationError> {
  if (!repository || records.length === 0) return Result.succeed(undefined);
  const appended = await repository.appendMany(records);
  if (Result.isFailure(appended)) {
    return Result.fail(
      new ActionRequestApplicationError(
        "audit_persistence_failed",
        appended.error.retriable,
        appended.error.message,
      ),
    );
  }
  return Result.succeed(undefined);
}

/**
 * adapterが永続化・復元したPrepared ActionRequestが、prepare時のPlanから改変されていないことを確認する。
 * checksumはMaterialized Plan自身が持つため、ここではPlanの自己整合とrequest/ID/組織の一致を検証する。
 */
async function verifyPreparedActionRequest(
  prepared: PreparedActionRequest,
): Result.ResultAsync<void, ActionRequestApplicationError> {
  const invalid = (message: string) =>
    Result.fail(
      new ActionRequestApplicationError("prepared_action_request_invalid", false, message),
    );
  const { plan, request } = prepared;
  if (String(plan.actionRequestId) !== String(prepared.actionRequestId)) {
    return invalid("Prepared ActionRequest IDとPlanのActionRequest IDが一致しません");
  }
  if (String(plan.organizationId) !== String(prepared.organizationId)) {
    return invalid("Prepared ActionRequestとPlanのorganizationが一致しません");
  }
  if (prepared.approvalRequired !== (plan.flow.type !== "none")) {
    return invalid("Prepared ActionRequestのapproval要否がPlanと一致しません");
  }
  const snapshot = plan.evaluationSnapshot;
  const requested = canonicalizeJson([
    request.actor,
    request.authority,
    request.origin,
  ] as unknown as JsonValue);
  const planned = canonicalizeJson([
    snapshot.actor,
    snapshot.authority,
    snapshot.origin,
  ] as unknown as JsonValue);
  if (
    Result.isFailure(requested) ||
    Result.isFailure(planned) ||
    requested.value !== planned.value ||
    String(request.action.type) !== String(plan.action.type) ||
    String(request.action.resource.type) !== String(plan.action.resource.type) ||
    String(request.action.resource.id) !== String(plan.action.resource.id)
  ) {
    return invalid("Prepared ActionRequestのrequestがPlanのsnapshotと一致しません");
  }
  const verification = await verifyMaterializedApprovalPlan(plan);
  if (verification.type !== "valid") return invalid(verification.message);
  return Result.succeed(undefined);
}

function requestView(input: {
  request: ActionRequest;
  plan: MaterializedApprovalPlan;
  status: ActionRequestPublicStatus;
  now: string;
  result?: ActionRequestView["result"];
}): ActionRequestView {
  const approvalRequired = input.plan.flow.type !== "none";
  return {
    id: String(input.plan.actionRequestId),
    organizationId: String(input.plan.organizationId),
    actor: input.request.actor,
    authorityPrincipal: input.request.authority.principal,
    ...(input.request.origin.caller ? { caller: input.request.origin.caller } : {}),
    action: input.request.action,
    origin: input.request.origin.type,
    status: input.status,
    approval: { required: approvalRequired },
    ...(input.result ? { result: input.result } : {}),
    checksums: {
      actionFingerprint: String(input.plan.actionFingerprint),
      evaluationSnapshotChecksum: String(input.plan.evaluationSnapshotChecksum),
      approvalPlanChecksum: String(input.plan.approvalPlanChecksum),
    },
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.status === "pending_approval" ? {} : { completedAt: input.now }),
  };
}

export class ActionRequestApplicationService {
  constructor(private readonly dependencies: ActionRequestApplicationServiceDependencies) {}

  async evaluate(input: {
    action: Action;
    trustedContext: TrustedActionRequestContext;
  }): Result.ResultAsync<ActionRequestEvaluation, ActionRequestApplicationError> {
    const actionRequestId = this.dependencies.idGenerator.next();

    const definition = await resolveActionDefinition({
      resolver: this.dependencies.actionDefinitionResolver,
      action: input.action,
    });
    if (Result.isFailure(definition)) return definition;

    const schema = await resolveSchema({
      resolver: this.dependencies.schemaResolver,
      definition: definition.value,
    });
    if (Result.isFailure(schema)) return schema;

    const validated = await validateSchema({ schema: schema.value, value: input.action.input });
    if (Result.isFailure(validated)) return validated;
    if (validated.value.type === "invalid") {
      return Result.fail(
        new ActionRequestApplicationError(
          "action_input_validation_failed",
          false,
          validated.value.issues.map((issue) => issue.message).join("; "),
          validated.value.issues.map((issue) => {
            const path = issuePath(issue.path);
            return path ? { message: issue.message, path } : { message: issue.message };
          }),
        ),
      );
    }
    if (!isRecord(validated.value.value)) {
      return Result.fail(
        new ActionRequestApplicationError(
          "action_input_not_object",
          false,
          "Action input schemaの出力はobjectである必要があります",
        ),
      );
    }

    const request: ActionRequest = {
      actor: input.trustedContext.actor,
      authority: input.trustedContext.authority,
      origin: input.trustedContext.origin,
      action: {
        ...input.action,
        input: validated.value.value,
      },
    };

    const authorization = await authorizeActionRequest({
      authorizer: this.dependencies.authorizer,
      request,
      evaluatedAt: input.trustedContext.now,
      consistency: "minimize_latency",
    });
    if (Result.isFailure(authorization)) {
      return Result.fail(
        new ActionRequestApplicationError(
          "authorization_provider_failed",
          authorization.error.retriable,
          authorization.error.message,
        ),
      );
    }
    if (authorization.value.type === "deny") {
      return Result.succeed({
        type: "authorization_denied",
        actionRequestId,
        code: authorization.value.code,
        reason: authorization.value.reason,
      });
    }

    const context: PolicyEvaluationContext = {
      ...request,
      organization: input.trustedContext.organization,
      ...(input.trustedContext.attributes ? { attributes: input.trustedContext.attributes } : {}),
      now: input.trustedContext.now,
    };

    const bindings = await this.dependencies.policyBindingResolver.resolve({
      context,
      actionDefinition: definition.value,
    });
    if (Result.isFailure(bindings)) {
      return Result.fail(mapDependencyError(bindings.error, "policy_binding_resolution_failed"));
    }

    const policyEvaluation = evaluateApprovalPlan({
      context,
      bindings: bindings.value.map((source) => source.binding),
      policies: bindings.value.map((source) => source.policy),
    });
    if (Result.isFailure(policyEvaluation)) {
      return Result.fail(
        new ActionRequestApplicationError(
          "policy_evaluation_failed",
          false,
          policyEvaluation.error.message,
        ),
      );
    }

    const materialized = await materializeApprovalPlan({
      actionRequestId,
      context,
      actionDefinition: definition.value,
      policyBindings: bindings.value,
    });
    if (materialized.type === "error") {
      return Result.fail(
        new ActionRequestApplicationError("materialization_failed", false, materialized.message),
      );
    }

    return Result.succeed({
      type: "evaluated",
      actionRequestId,
      request,
      context,
      actionDefinition: definition.value,
      bindings: bindings.value,
      policyEvaluation: policyEvaluation.value,
      authorizationEvidence: authorization.value.evidence,
      plan: materialized.plan,
    });
  }

  /**
   * ActionRequestを1回だけ評価し、immutableなPrepared ActionRequestを確定する。
   *
   * Authorization / Policy評価 / Materialized Plan確定 / ActionRequest ID確定までを行い、
   * Plan保存・audit・Workflow開始・Executor呼び出しといった副作用は一切起こさない。
   * adapterはprepared planを見てadmission（例: MCP Tasks capability / Task予約）を判断し、
   * 成功した場合だけ `commit` へ同じpreparationを渡す。
   */
  async prepare(input: {
    action: Action;
    trustedContext: TrustedActionRequestContext;
  }): Result.ResultAsync<ActionRequestPreparation, ActionRequestApplicationError> {
    const evaluated = await this.evaluate(input);
    if (Result.isFailure(evaluated)) return evaluated;
    if (evaluated.value.type === "authorization_denied") {
      return Result.succeed({
        ...evaluated.value,
        organizationId: input.trustedContext.organization.id,
        deniedAt: input.trustedContext.now,
      });
    }
    const { actionRequestId, request, plan, authorizationEvidence } = evaluated.value;
    return Result.succeed({
      type: "prepared",
      prepared: {
        actionRequestId,
        organizationId: plan.organizationId,
        request,
        plan,
        authorizationEvidence,
        approvalRequired: plan.flow.type !== "none",
        preparedAt: input.trustedContext.now,
      },
    });
  }

  /**
   * `prepare` で確定したpreparationをそのままcommitする。
   *
   * Policyを再評価せず、prepared planと同一checksumのPlanだけを保存する。
   * `resume: true` はadmission後のcommit failureからの復旧用で、同じPlanが既に保存済みなら
   * 続きのaudit（eventKeyで重複排除）/ Workflow開始（instance IDは決定的）を再試行する。
   */
  async commit(input: {
    preparation: ActionRequestPreparation;
    /** immediate execution時のRe-Authorization評価時刻。省略時はpreparedAt。 */
    now?: string;
    resume?: boolean;
  }): Result.ResultAsync<ActionRequestSubmitResult, ActionRequestApplicationError> {
    const preparation = input.preparation;
    if (preparation.type === "authorization_denied") {
      const audited = await appendAudit(this.dependencies.eventRepository, [
        actionEventRecord({
          organizationId: preparation.organizationId,
          occurredAt: preparation.deniedAt,
          event: {
            type: "action.authorization_denied",
            actionRequestId: preparation.actionRequestId,
            code: preparation.code,
            reason: preparation.reason,
          },
        }),
      ]);
      if (Result.isFailure(audited)) return audited;
      return Result.succeed({
        type: "authorization_denied",
        actionRequestId: preparation.actionRequestId,
        code: preparation.code,
        reason: preparation.reason,
      });
    }

    const { actionRequestId, request, plan } = preparation.prepared;
    const integrity = await verifyPreparedActionRequest(preparation.prepared);
    if (Result.isFailure(integrity)) return integrity;

    const saved = await this.dependencies.planRepository.save(plan);
    if (saved.type !== "created" && !(saved.type === "existing" && input.resume === true)) {
      return Result.fail(planPersistenceError(saved));
    }

    const initialAudit = await appendAudit(
      this.dependencies.eventRepository,
      actionPlanAuditEvents({
        plan,
        authorizationEvidence: preparation.prepared.authorizationEvidence,
      }),
    );
    if (Result.isFailure(initialAudit)) return initialAudit;

    const now = input.now ?? preparation.prepared.preparedAt;
    if (plan.flow.type !== "none") {
      const started = await this.dependencies.workflowStarter.start({
        plan,
        startedAt: now,
      });
      if (Result.isFailure(started)) {
        return Result.fail(mapDependencyError(started.error, "workflow_start_failed"));
      }
      return Result.succeed({
        type: "accepted",
        actionRequestId,
        request,
        plan,
        workflowInstanceId: started.value.workflowInstanceId,
        view: requestView({
          request,
          plan,
          status: "pending_approval",
          now,
        }),
      });
    }

    return this.executeImmediately({ actionRequestId, request, plan, now });
  }

  async submit(input: {
    action: Action;
    trustedContext: TrustedActionRequestContext;
    idempotencyKey?: string;
    clientReference?: string;
  }): Result.ResultAsync<ActionRequestSubmitResult, ActionRequestApplicationError> {
    const prepared = await this.prepare({
      action: input.action,
      trustedContext: input.trustedContext,
    });
    if (Result.isFailure(prepared)) return prepared;
    return this.commit({ preparation: prepared.value, now: input.trustedContext.now });
  }

  private async executeImmediately(input: {
    actionRequestId: ActionRequestId;
    request: ActionRequest;
    plan: MaterializedApprovalPlan;
    now: string;
  }): Result.ResultAsync<ActionRequestSubmitResult, ActionRequestApplicationError> {
    const { actionRequestId, request, plan, now } = input;
    const execution = await executeActionRequest({
      authorizer: this.dependencies.authorizer,
      executor: this.dependencies.executor,
      organizationId: plan.organizationId,
      actionRequestId,
      request,
      actionFingerprint: plan.actionFingerprint,
      action: plan.action,
      evaluatedAt: now,
    });
    if (Result.isFailure(execution)) {
      const failedEvents: ActionEventRecord[] = [];
      if (execution.error instanceof ActionAuthorizationCheckFailedError) {
        failedEvents.push(
          actionEventRecord({
            organizationId: plan.organizationId,
            occurredAt: now,
            event: {
              type: "action.reauthorization_check_failed",
              actionRequestId,
              code: execution.error.providerCode,
            },
          }),
        );
        failedEvents.push(
          actionEventRecord({
            organizationId: plan.organizationId,
            occurredAt: now,
            event: {
              type: "action.completed",
              actionRequestId,
              result: "authorization_check_failed",
            },
          }),
        );
      } else if (execution.error instanceof ActionExecutorError) {
        const idempotencyKey = createActionExecutionIdempotencyKey(
          plan.organizationId,
          actionRequestId,
          plan.actionFingerprint,
        );
        failedEvents.push(
          actionEventRecord({
            organizationId: plan.organizationId,
            occurredAt: now,
            event: {
              type: "action.execution_started",
              actionRequestId,
              idempotencyKey,
            },
          }),
          actionEventRecord({
            organizationId: plan.organizationId,
            occurredAt: now,
            event: {
              type: "action.execution_failed",
              actionRequestId,
              code: execution.error.code,
              retriable: execution.error.retriable,
            },
          }),
          actionEventRecord({
            organizationId: plan.organizationId,
            occurredAt: now,
            event: {
              type: "action.completed",
              actionRequestId,
              result: "execution_failed",
            },
          }),
        );
      }
      const audited = await appendAudit(this.dependencies.eventRepository, failedEvents);
      if (Result.isFailure(audited)) return audited;

      return Result.fail(
        new ActionRequestApplicationError(
          "execution_failed",
          execution.error.retriable,
          execution.error.message,
          undefined,
          execution.error instanceof ActionExecutorError ? execution.error.code : undefined,
        ),
      );
    }

    if (execution.value.type === "authorization_revoked") {
      const audited = await appendAudit(this.dependencies.eventRepository, [
        actionEventRecord({
          organizationId: plan.organizationId,
          occurredAt: now,
          event: {
            type: "action.reauthorization_denied",
            actionRequestId,
            code: execution.value.code,
            reason: execution.value.reason,
          },
        }),
        actionEventRecord({
          organizationId: plan.organizationId,
          occurredAt: now,
          event: {
            type: "action.completed",
            actionRequestId,
            result: "authorization_revoked",
          },
        }),
      ]);
      if (Result.isFailure(audited)) return audited;

      return Result.succeed({
        type: "accepted",
        actionRequestId,
        request,
        plan,
        view: requestView({
          request,
          plan,
          status: "authorization_revoked",
          now,
          result: {
            status: "authorization_revoked",
            code: execution.value.code,
            message: execution.value.reason,
          },
        }),
      });
    }

    const executionAudit = await appendAudit(this.dependencies.eventRepository, [
      actionEventRecord({
        organizationId: plan.organizationId,
        occurredAt: execution.value.authorizationEvidence.evaluatedAt,
        event: {
          type: "action.reauthorized",
          actionRequestId,
          evidence: execution.value.authorizationEvidence,
        },
      }),
      actionEventRecord({
        organizationId: plan.organizationId,
        occurredAt: now,
        event: {
          type: "action.execution_started",
          actionRequestId,
          idempotencyKey: execution.value.idempotencyKey,
        },
      }),
      actionEventRecord({
        organizationId: plan.organizationId,
        occurredAt: now,
        event: {
          type: "action.completed",
          actionRequestId,
          result: "executed",
        },
      }),
    ]);
    if (Result.isFailure(executionAudit)) return executionAudit;

    return Result.succeed({
      type: "accepted",
      actionRequestId,
      request,
      plan,
      view: requestView({
        request,
        plan,
        status: "executed",
        now,
        result: {
          status: "executed",
          ...(execution.value.result.output !== undefined
            ? { output: execution.value.result.output }
            : {}),
        },
      }),
    });
  }
}
