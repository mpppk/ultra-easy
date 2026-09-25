import { Result } from "@praha/byethrow";

import {
  approvalFlowPresentation,
  decodeUriComponent,
  isManagedRelationship,
  RELATIONSHIP_AUDIT_EVENT_TYPES,
  RELATIONSHIP_SYNC_STATUSES,
} from "@app/approval-core";
import type {
  Action,
  ActionType,
  ApprovalFlowPresentation,
  AuthorizationAdminPermission,
  AuthorizationProviderError,
  AuthorizationRelationshipReadRepository,
  AuthorizationRelationshipRecord,
  AuthorizationRelationshipRepositoryError,
  JsonValue,
  ManagedRelationshipCatalog,
  OrganizationId,
  PrincipalRef,
  RelationshipAuditEvent,
  RelationshipAuditEventType,
  RelationshipMutationRecord,
  RelationshipOperation,
  RelationshipSyncStatus,
  RelationshipTuple,
  ResourceId,
  ResourceType,
  UserPrincipalRef,
} from "@app/approval-core";

import type {
  ActionRequestApplicationError,
  ActionRequestApplicationService,
  ActionRequestValidationIssue,
  TrustedActionRequestContext,
} from "./action-request-service.ts";
import type { HttpTrustedContextError } from "./http.ts";
import type { ApplicablePolicySimulation } from "./simulator.ts";

/** The real, authenticated console user. Organization comes from identity, never the request. */
export type AuthorizationAdminCaller = {
  organizationId: OrganizationId;
  principal: UserPrincipalRef;
};

export interface AuthorizationAdminCallerResolver {
  resolve(request: Request): Result.ResultAsync<AuthorizationAdminCaller, HttpTrustedContextError>;
}

/** FGA check of `authorization_admin:root#viewer|editor` for the caller. Errors fail closed. */
export interface AuthorizationAdminAccessChecker {
  check(input: {
    caller: AuthorizationAdminCaller;
    permission: AuthorizationAdminPermission;
  }): Result.ResultAsync<boolean, AuthorizationProviderError>;
}

export type AuthorizationTargetDescription = {
  relation: string;
  logicalObject: string;
  providerObject: string;
  authorizationModelId: string;
};

/** Describes which FGA relation/object the ActionAuthorizer checks for an Action (no I/O). */
export interface AuthorizationTargetDescriber {
  describe(input: {
    organizationId: OrganizationId;
    action: Pick<Action, "type" | "resource">;
  }): AuthorizationTargetDescription | null;
  providerObject(input: { organizationId: OrganizationId; logicalObject: string }): string;
}

export type AuthorizationModelView = {
  activeModelId: string;
  provider: { apiHost: string; storeId: string };
  schemaVersion: string;
  typeDefinitions: Array<{ type: string; relations: string[]; definition: JsonValue }>;
  conditions: string[];
  providerChecksum: string;
  source: {
    path: string;
    testsPath: string;
    checksum: string;
    matchesProvider: boolean;
    revision: string | null;
  };
  readOnly: true;
};

export class AuthorizationAdminDependencyError extends Error {
  readonly name = "AuthorizationAdminDependencyError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthorizationModelInspector {
  inspect(): Result.ResultAsync<AuthorizationModelView, AuthorizationAdminDependencyError>;
}

/** Exact provider read of one logical tuple (inspection / reconciliation view). */
export interface AuthorizationRelationshipObserver {
  observe(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
  }): Result.ResultAsync<{ present: boolean }, AuthorizationAdminDependencyError>;
}

export type ExplorerActionType = {
  actionType: string;
  executorKey: string;
  schemaKey: string;
};

export interface ExplorerActionCatalog {
  list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<ExplorerActionType[], AuthorizationAdminDependencyError>;
}

export type AuthorizationExplainRequest = {
  principal: PrincipalRef;
  action: { type: ActionType; resource: Action["resource"]; input: unknown };
  simulationOverrides?: Record<string, JsonValue>;
};

export type AuthorizationEffectiveOutcome =
  | "deny"
  | "allowed_no_approval"
  | "allowed_requires_approval"
  | "evaluation_error";

export type AuthorizationExplainResult = {
  evaluatedAt: string;
  organizationId: string;
  /** The real console user who ran the simulation (viewer-authorized). */
  caller: PrincipalRef;
  /** The principal being inspected. Never persisted as an actor. */
  simulatedPrincipal: PrincipalRef;
  action: { type: string; resource: { type: string; id: string } };
  normalizedInput: JsonValue | null;
  authorization: {
    outcome: "allow" | "deny" | "error" | "not_evaluated";
    relation: string | null;
    logicalObject: string | null;
    providerObject: string | null;
    consistency: "minimize_latency";
    authorizationModelId: string | null;
    code?: string;
    reason?: string;
  };
  applicablePolicies: ApplicablePolicySimulation[];
  approvalFlow: ApprovalFlowPresentation | null;
  effectiveOutcome: AuthorizationEffectiveOutcome;
  error?: { code: string; message: string; issues?: ActionRequestValidationIssue[] };
  /** Proof/path graphs are not produced (OpenFGA does not return them). */
  proof: null;
};

/** Error codes that only occur after the Authorization check allowed the request. */
const POST_AUTHORIZATION_ERRORS = new Set([
  "policy_binding_resolution_failed",
  "policy_evaluation_failed",
  "materialization_failed",
]);

/** Messages safe to echo: schema/policy issues. Provider failures only expose their code. */
const ECHO_MESSAGE_ERRORS = new Set([
  "action_input_validation_failed",
  "action_input_not_object",
  "policy_evaluation_failed",
  "materialization_failed",
]);

/**
 * Side-effect free Explorer evaluation (AC-M9-002). Reuses the exact
 * ActionRequest evaluate() path (Action Definition, schema validation,
 * Authorization, Policy Binding, Policy evaluation, Plan materialization) and
 * never persists, starts Workflows or calls executors. Anything that cannot be
 * evaluated completely is reported as `evaluation_error`, never as
 * "no approval".
 */
export class AuthorizationExplainService {
  private readonly simulatableAttributes: ReadonlySet<string>;

  constructor(
    private readonly dependencies: {
      service: ActionRequestApplicationService;
      describer: AuthorizationTargetDescriber;
      clock: { now(): string };
      /** Allow-listed attribute keys a caller may override in simulation. Empty by default. */
      simulatableAttributes?: readonly string[];
    },
  ) {
    this.simulatableAttributes = new Set(dependencies.simulatableAttributes ?? []);
  }

  get supportedSimulationOverrides(): string[] {
    return [...this.simulatableAttributes].sort();
  }

  async explain(input: {
    caller: AuthorizationAdminCaller;
    request: AuthorizationExplainRequest;
  }): Promise<AuthorizationExplainResult> {
    const now = this.dependencies.clock.now();
    const { caller, request } = input;
    const target = this.dependencies.describer.describe({
      organizationId: caller.organizationId,
      action: request.action,
    });
    const base = {
      evaluatedAt: now,
      organizationId: String(caller.organizationId),
      caller: caller.principal,
      simulatedPrincipal: request.principal,
      action: {
        type: String(request.action.type),
        resource: {
          type: String(request.action.resource.type),
          id: String(request.action.resource.id),
        },
      },
      proof: null,
    } as const;
    const authorizationTarget = {
      relation: target?.relation ?? null,
      logicalObject: target?.logicalObject ?? null,
      providerObject: target?.providerObject ?? null,
      consistency: "minimize_latency" as const,
      authorizationModelId: target?.authorizationModelId ?? null,
    };
    const errorResult = (
      outcome: AuthorizationExplainResult["authorization"]["outcome"],
      error: NonNullable<AuthorizationExplainResult["error"]>,
    ): AuthorizationExplainResult => ({
      ...base,
      normalizedInput: null,
      authorization: { ...authorizationTarget, outcome },
      applicablePolicies: [],
      approvalFlow: null,
      effectiveOutcome: "evaluation_error",
      error,
    });

    const overrides = Object.keys(request.simulationOverrides ?? {});
    const rejected = overrides.filter((key) => !this.simulatableAttributes.has(key));
    if (rejected.length > 0) {
      return errorResult("not_evaluated", {
        code: "simulation_override_not_allowed",
        message: `simulationできない項目です: ${rejected.join(", ")}`,
      });
    }

    const attributes = Object.fromEntries(
      Object.entries(request.simulationOverrides ?? {}).filter(([key]) =>
        this.simulatableAttributes.has(key),
      ),
    );
    const trustedContext: TrustedActionRequestContext = {
      actor: request.principal,
      authority: { principal: request.principal },
      origin: { type: "ui" },
      organization: { id: caller.organizationId },
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      now,
    };

    const evaluated = await this.dependencies.service.evaluate({
      action: {
        type: request.action.type,
        resource: request.action.resource,
        input: request.action.input as Record<string, unknown>,
      },
      trustedContext,
    });

    if (Result.isFailure(evaluated)) {
      const error: ActionRequestApplicationError = evaluated.error;
      const outcome =
        error.code === "authorization_provider_failed"
          ? "error"
          : POST_AUTHORIZATION_ERRORS.has(error.code)
            ? "allow"
            : "not_evaluated";
      return errorResult(outcome, {
        code: error.code,
        message: ECHO_MESSAGE_ERRORS.has(error.code)
          ? error.message
          : "評価に必要な依存先を利用できませんでした",
        ...(error.issues ? { issues: [...error.issues] } : {}),
      });
    }

    if (evaluated.value.type === "authorization_denied") {
      return {
        ...base,
        normalizedInput: null,
        authorization: {
          ...authorizationTarget,
          outcome: "deny",
          code: evaluated.value.code,
          reason: evaluated.value.reason,
        },
        applicablePolicies: [],
        approvalFlow: null,
        effectiveOutcome: "deny",
      };
    }

    const { plan, bindings, policyEvaluation, authorizationEvidence } = evaluated.value;
    const versions = new Map(
      bindings.map((source) => [String(source.binding.id), source.policyVersion]),
    );
    const applicablePolicies = policyEvaluation.policyEvaluations.map(
      ({ binding, evaluation }): ApplicablePolicySimulation => ({
        bindingId: String(binding.id),
        policyKey: String(binding.policyKey),
        policyVersion: versions.get(String(binding.id)) ?? 1,
        matchedRuleKey: evaluation.type === "matched" ? String(evaluation.ruleKey) : null,
        outcome: evaluation.type === "matched" && evaluation.flow.type !== "none" ? "flow" : "none",
      }),
    );
    const approvalFlow = approvalFlowPresentation(plan);
    return {
      ...base,
      normalizedInput: plan.action.input,
      authorization: {
        ...authorizationTarget,
        outcome: "allow",
        authorizationModelId:
          authorizationEvidence.authorizationModelId ?? authorizationTarget.authorizationModelId,
      },
      applicablePolicies,
      approvalFlow,
      effectiveOutcome: approvalFlow.requiresApproval
        ? "allowed_requires_approval"
        : "allowed_no_approval",
    };
  }
}

function problem(input: {
  status: number;
  code: string;
  title: string;
  detail?: string;
}): Response {
  return new Response(
    JSON.stringify({
      type: `urn:ultra-easy:problem:${input.code}`,
      title: input.title,
      status: input.status,
      code: input.code,
      ...(input.detail ? { detail: input.detail } : {}),
    }),
    { status: input.status, headers: { "content-type": "application/problem+json" } },
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

export function parseAuthorizationExplainBody(value: unknown): AuthorizationExplainRequest | null {
  if (!isRecord(value)) return null;
  if (
    !Object.keys(value).every((key) => ["principal", "action", "simulationOverrides"].includes(key))
  )
    return null;
  const principal = value.principal;
  if (
    !isRecord(principal) ||
    !Object.keys(principal).every((key) => key === "type" || key === "id") ||
    (principal.type !== "user" && principal.type !== "agent" && principal.type !== "service") ||
    !nonEmptyString(principal.id, 255)
  ) {
    return null;
  }
  const action = value.action;
  if (
    !isRecord(action) ||
    !Object.keys(action).every((key) => ["type", "resource", "input"].includes(key)) ||
    !nonEmptyString(action.type, 255) ||
    !isRecord(action.resource) ||
    !Object.keys(action.resource).every((key) => key === "type" || key === "id") ||
    !nonEmptyString(action.resource.type, 255) ||
    !nonEmptyString(action.resource.id, 512)
  ) {
    return null;
  }
  const overrides = value.simulationOverrides;
  if (overrides !== undefined && (!isRecord(overrides) || !isJsonValue(overrides))) return null;
  return {
    principal: { type: principal.type, id: principal.id.trim() } as PrincipalRef,
    action: {
      type: action.type.trim() as ActionType,
      resource: {
        type: action.resource.type.trim() as ResourceType,
        id: action.resource.id.trim() as ResourceId,
      },
      // Missing/invalid input is not a 400: it flows into schema validation and
      // becomes `evaluation_error` with issues, exactly like a real submit.
      input: action.input,
    },
    ...(overrides !== undefined
      ? { simulationOverrides: overrides as Record<string, JsonValue> }
      : {}),
  };
}

export type RelationshipView = {
  tupleKey: string;
  subject: string;
  relation: string;
  object: string;
  objectType: string;
  /** Debug/details only; the UI shows the logical object. */
  providerObject: string;
  managed: boolean;
  desiredState: "present" | "absent";
  revision: number;
  confirmedRevision: number | null;
  confirmedState: "present" | "absent" | null;
  syncStatus: RelationshipSyncStatus;
  lastErrorCode: string | null;
  sourceActionRequestId: string;
  latestMutationKey: string;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipMutationView = {
  mutationKey: string;
  actionRequestId: string;
  revision: number;
  operation: RelationshipOperation;
  desiredState: "present" | "absent";
  status: RelationshipMutationRecord["status"];
  actor: PrincipalRef;
  authorizationModelId: string;
  attemptCount: number;
  requestedAt: string;
  applyStartedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
};

export type RelationshipAuditView = {
  sequence: number;
  eventKey: string;
  type: RelationshipAuditEventType;
  /** `requested` = intent recorded; `confirmed` = provider effect observed. */
  phase:
    | "requested"
    | "apply_started"
    | "confirmed"
    | "indeterminate"
    | "superseded"
    | "failed"
    | "drift_repaired";
  occurredAt: string;
  actor: PrincipalRef;
  sourceActionRequestId: string;
  mutationKey: string;
  tupleKey: string;
  revision: number;
  operation: RelationshipOperation;
  desiredState: "present" | "absent";
  subject: string;
  relation: string;
  object: string;
  providerObject: string;
  authorizationModelId: string;
  errorCode: string | null;
};

function state(present: boolean): "present" | "absent" {
  return present ? "present" : "absent";
}

function relationshipView(
  record: AuthorizationRelationshipRecord,
  providerObject: string,
  catalog: ManagedRelationshipCatalog,
): RelationshipView {
  return {
    tupleKey: record.tupleKey,
    subject: record.tuple.user,
    relation: record.tuple.relation,
    object: record.tuple.object,
    objectType: record.objectType,
    providerObject,
    managed: isManagedRelationship(
      { objectType: record.objectType, relation: record.tuple.relation },
      catalog,
    ),
    desiredState: state(record.desiredPresent),
    revision: record.revision,
    confirmedRevision: record.confirmedRevision,
    confirmedState: record.confirmedPresent === null ? null : state(record.confirmedPresent),
    syncStatus: record.syncStatus,
    lastErrorCode: record.lastErrorCode,
    sourceActionRequestId: String(record.latestActionRequestId),
    latestMutationKey: record.latestMutationKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mutationView(record: RelationshipMutationRecord): RelationshipMutationView {
  return {
    mutationKey: record.mutationKey,
    actionRequestId: String(record.actionRequestId),
    revision: record.revision,
    operation: record.operation,
    desiredState: state(record.desiredPresent),
    status: record.status,
    actor: record.actor,
    authorizationModelId: record.authorizationModelId,
    attemptCount: record.attemptCount,
    requestedAt: record.requestedAt,
    applyStartedAt: record.applyStartedAt,
    confirmedAt: record.confirmedAt,
    completedAt: record.completedAt,
    lastErrorCode: record.lastErrorCode,
  };
}

const AUDIT_PHASE: Record<RelationshipAuditEventType, RelationshipAuditView["phase"]> = {
  "authorization.relationship_change_requested": "requested",
  "authorization.relationship_apply_started": "apply_started",
  "authorization.relationship_change_confirmed": "confirmed",
  "authorization.relationship_change_indeterminate": "indeterminate",
  "authorization.relationship_change_superseded": "superseded",
  "authorization.relationship_change_failed": "failed",
  "authorization.relationship_drift_repaired": "drift_repaired",
};

export function relationshipAuditView(
  event: RelationshipAuditEvent,
  providerObject: string,
): RelationshipAuditView {
  return {
    sequence: event.sequence,
    eventKey: event.eventKey,
    type: event.type,
    phase: AUDIT_PHASE[event.type],
    occurredAt: event.occurredAt,
    actor: event.actor,
    sourceActionRequestId: String(event.sourceActionRequestId),
    mutationKey: event.mutationKey,
    tupleKey: event.tupleKey,
    revision: event.revision,
    operation: event.operation,
    desiredState: state(event.desiredPresent),
    subject: event.tuple.user,
    relation: event.tuple.relation,
    object: event.tuple.object,
    providerObject,
    authorizationModelId: event.authorizationModelId,
    errorCode: event.errorCode,
  };
}

function repositoryProblem(error: AuthorizationRelationshipRepositoryError): Response {
  if (error.code === "invalid_cursor") {
    return problem({ status: 400, code: error.code, title: "cursorが不正です" });
  }
  return problem({
    status: error.retriable ? 503 : 500,
    code: error.code,
    title: "Authorization read modelを利用できません",
  });
}

function parseLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

function optionalParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

const ADMIN_PREFIX = "/v1/admin/authorization";

/**
 * Authorization Administration Console HTTP API (M9).
 *
 * - The organization is taken from the authenticated identity; requests
 *   never select it (no `organizationId` parameter exists).
 * - Every data route requires `authorization_admin:root#viewer`; provider
 *   errors fail closed (503), never allow.
 * - Read-only. There is no relationship mutation endpoint: add/delete goes
 *   through `POST /v1/organizations/{org}/action-requests` with
 *   `authorization.relationship.update`. There is no model write endpoint.
 */
export function createAuthorizationAdminHttpApi(input: {
  callerResolver: AuthorizationAdminCallerResolver;
  accessChecker: AuthorizationAdminAccessChecker;
  explainService: AuthorizationExplainService;
  relationships: AuthorizationRelationshipReadRepository;
  describer: AuthorizationTargetDescriber;
  modelInspector: AuthorizationModelInspector;
  catalog: ManagedRelationshipCatalog;
  observer?: AuthorizationRelationshipObserver;
  actionCatalog?: ExplorerActionCatalog;
  provider: { apiHost: string; storeId: string; authorizationModelId: string };
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  async function authorize(
    request: Request,
    permission: AuthorizationAdminPermission,
  ): Promise<AuthorizationAdminCaller | Response> {
    const caller = await input.callerResolver.resolve(request);
    if (Result.isFailure(caller)) {
      return problem({
        status: caller.error.status,
        code: caller.error.code,
        title: caller.error.status === 401 ? "Authentication required" : "Forbidden",
      });
    }
    const allowed = await input.accessChecker.check({ caller: caller.value, permission });
    if (Result.isFailure(allowed)) {
      return problem({
        status: 503,
        code: "authorization_admin_check_failed",
        title: "Authorization providerを利用できません",
      });
    }
    if (!allowed.value) {
      return problem({
        status: 403,
        code: "authorization_admin_forbidden",
        title: `authorization_admin:root#${permission}が必要です`,
      });
    }
    return caller.value;
  }

  return {
    handles(request: Request): boolean {
      const path = new URL(request.url).pathname;
      return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);
    },

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === `${ADMIN_PREFIX}/session`) {
        const caller = await input.callerResolver.resolve(request);
        if (Result.isFailure(caller)) {
          return problem({
            status: caller.error.status,
            code: caller.error.code,
            title: caller.error.status === 401 ? "Authentication required" : "Forbidden",
          });
        }
        const [viewer, editor] = await Promise.all([
          input.accessChecker.check({ caller: caller.value, permission: "viewer" }),
          input.accessChecker.check({ caller: caller.value, permission: "editor" }),
        ]);
        if (Result.isFailure(viewer) || Result.isFailure(editor)) {
          return problem({
            status: 503,
            code: "authorization_admin_check_failed",
            title: "Authorization providerを利用できません",
          });
        }
        return json({
          organizationId: String(caller.value.organizationId),
          principal: caller.value.principal,
          permissions: { viewer: viewer.value, editor: editor.value },
          provider: viewer.value ? input.provider : null,
        });
      }

      if (request.method === "POST" && path === `${ADMIN_PREFIX}/explain`) {
        const caller = await authorize(request, "viewer");
        if (caller instanceof Response) return caller;
        const body = parseAuthorizationExplainBody(await request.json().catch(() => null));
        if (!body) {
          return problem({
            status: 400,
            code: "invalid_explain_request",
            title: "principal / action(type, resource)が必要です",
          });
        }
        return json(await input.explainService.explain({ caller, request: body }));
      }

      if (request.method === "GET" && path === `${ADMIN_PREFIX}/catalog`) {
        const caller = await authorize(request, "viewer");
        if (caller instanceof Response) return caller;
        const actionTypes = input.actionCatalog
          ? await input.actionCatalog.list({ organizationId: caller.organizationId })
          : Result.succeed([]);
        return json({
          managedRelationships: input.catalog,
          simulationOverrides: input.explainService.supportedSimulationOverrides,
          actionTypes: Result.isSuccess(actionTypes) ? actionTypes.value : [],
          syncStatuses: RELATIONSHIP_SYNC_STATUSES,
          auditEventTypes: RELATIONSHIP_AUDIT_EVENT_TYPES,
        });
      }

      if (request.method === "GET" && path === `${ADMIN_PREFIX}/relationships`) {
        const caller = await authorize(request, "viewer");
        if (caller instanceof Response) return caller;
        const limit = parseLimit(url);
        const syncStatus = optionalParam(url, "syncStatus");
        if (
          limit === null ||
          (syncStatus !== undefined &&
            !RELATIONSHIP_SYNC_STATUSES.includes(syncStatus as RelationshipSyncStatus))
        ) {
          return problem({
            status: 400,
            code: "invalid_relationship_query",
            title: "Relationship queryが不正です",
          });
        }
        const subject = optionalParam(url, "subject");
        const relation = optionalParam(url, "relation");
        const object = optionalParam(url, "object");
        const cursor = optionalParam(url, "cursor");
        const listed = await input.relationships.list({
          organizationId: caller.organizationId,
          limit,
          ...(subject ? { subject } : {}),
          ...(relation ? { relation } : {}),
          ...(object ? { object } : {}),
          ...(syncStatus ? { syncStatus: syncStatus as RelationshipSyncStatus } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (Result.isFailure(listed)) return repositoryProblem(listed.error);
        return json({
          items: listed.value.items.map((record) =>
            relationshipView(
              record,
              input.describer.providerObject({
                organizationId: caller.organizationId,
                logicalObject: record.tuple.object,
              }),
              input.catalog,
            ),
          ),
          nextCursor: listed.value.nextCursor,
        });
      }

      const detail = new RegExp(`^${ADMIN_PREFIX}/relationships/([^/]+)$`).exec(path);
      if (request.method === "GET" && detail?.[1]) {
        const caller = await authorize(request, "viewer");
        if (caller instanceof Response) return caller;
        const decodedKey = decodeUriComponent(detail[1]);
        if (Result.isFailure(decodedKey)) {
          return problem({ status: 400, code: "invalid_tuple_key", title: "tuple keyが不正です" });
        }
        const tupleKey = decodedKey.value;
        const loaded = await input.relationships.get({
          organizationId: caller.organizationId,
          tupleKey,
        });
        if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
        if (!loaded.value) {
          return problem({
            status: 404,
            code: "relationship_not_found",
            title: "Relationship not found",
          });
        }
        const observed =
          url.searchParams.get("observe") === "true" && input.observer
            ? await input.observer.observe({
                organizationId: caller.organizationId,
                tuple: loaded.value.relationship.tuple,
              })
            : null;
        return json({
          relationship: relationshipView(
            loaded.value.relationship,
            input.describer.providerObject({
              organizationId: caller.organizationId,
              logicalObject: loaded.value.relationship.tuple.object,
            }),
            input.catalog,
          ),
          mutations: loaded.value.mutations.map(mutationView),
          provider:
            observed === null
              ? null
              : Result.isSuccess(observed)
                ? { observedState: state(observed.value.present), error: null }
                : { observedState: null, error: observed.error.code },
        });
      }

      if (request.method === "GET" && path === `${ADMIN_PREFIX}/model`) {
        const caller = await authorize(request, "viewer");
        if (caller instanceof Response) return caller;
        const model = await input.modelInspector.inspect();
        if (Result.isFailure(model)) {
          return problem({
            status: model.error.retriable ? 503 : 502,
            code: model.error.code,
            title: "Authorization modelを取得できません",
          });
        }
        return json(model.value);
      }

      if (request.method === "GET" && path === `${ADMIN_PREFIX}/audit`) {
        const caller = await authorize(request, "viewer");
        if (caller instanceof Response) return caller;
        const limit = parseLimit(url);
        const eventType = optionalParam(url, "eventType");
        const operation = optionalParam(url, "operation");
        const revisionRaw = optionalParam(url, "revision");
        const revision = revisionRaw === undefined ? undefined : Number(revisionRaw);
        const from = optionalParam(url, "from");
        const to = optionalParam(url, "to");
        if (
          limit === null ||
          (eventType !== undefined &&
            !RELATIONSHIP_AUDIT_EVENT_TYPES.includes(eventType as RelationshipAuditEventType)) ||
          (operation !== undefined && operation !== "write" && operation !== "delete") ||
          (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) ||
          (from !== undefined && Number.isNaN(Date.parse(from))) ||
          (to !== undefined && Number.isNaN(Date.parse(to)))
        ) {
          return problem({
            status: 400,
            code: "invalid_audit_query",
            title: "Audit queryが不正です",
          });
        }
        const filters = {
          actorId: optionalParam(url, "actor"),
          subject: optionalParam(url, "subject"),
          relation: optionalParam(url, "relation"),
          object: optionalParam(url, "object"),
          sourceActionRequestId: optionalParam(url, "actionRequestId"),
          mutationKey: optionalParam(url, "mutationKey"),
          cursor: optionalParam(url, "cursor"),
        };
        const listed = await input.relationships.listAudit({
          organizationId: caller.organizationId,
          limit,
          ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
          ...(eventType ? { eventType: eventType as RelationshipAuditEventType } : {}),
          ...(operation ? { operation: operation as RelationshipOperation } : {}),
          ...(revision !== undefined ? { revision } : {}),
          ...(from ? { from: new Date(from).toISOString() } : {}),
          ...(to ? { to: new Date(to).toISOString() } : {}),
        });
        if (Result.isFailure(listed)) return repositoryProblem(listed.error);
        return json({
          items: listed.value.items.map((event) =>
            relationshipAuditView(
              event,
              input.describer.providerObject({
                organizationId: caller.organizationId,
                logicalObject: event.tuple.object,
              }),
            ),
          ),
          nextCursor: listed.value.nextCursor,
        });
      }

      return problem({ status: 404, code: "not_found", title: "Not Found" });
    },
  };
}
