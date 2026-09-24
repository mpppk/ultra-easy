import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { FgaAccessTokenSupplier } from "./token-provider.ts";

import {
  ApproverResolverProviderError,
  AuthorizationProviderError,
  actionCorrelation,
  metricRecord,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionRequest,
  ActionRequestId,
  ActionType,
  ApproverCandidateList,
  ApproverResolver,
  AuthorizationConsistency,
  AuthorizationDecision,
  AuthorizationObjectRef,
  OrganizationId,
  RelationName,
  ResolvedApproverTarget,
  TelemetrySink,
  UserId,
} from "@app/approval-core";

const OpenFgaRequestErrorBase = ErrorFactory({
  name: "OpenFgaRequestError",
  message: ({ detail }) => `OpenFGA requestに失敗しました: ${detail}`,
  fields: ErrorFactory.fields<{
    code: string;
    detail: string;
    retriable: boolean;
    status?: number;
  }>(),
});

export class OpenFgaRequestError extends OpenFgaRequestErrorBase {
  constructor(options: {
    code: string;
    detail: string;
    retriable: boolean;
    status?: number;
    cause?: Error;
  }) {
    super({
      code: options.code,
      detail: options.detail,
      retriable: options.retriable,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.cause ? { cause: options.cause } : {}),
    });
  }
}

function errorCause(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

const fetchRequest = Result.fn({
  try: async (input: {
    fetch: typeof globalThis.fetch;
    url: string;
    init: RequestInit;
  }): Promise<Response> => input.fetch(input.url, input.init),
  catch: (error): OpenFgaRequestError =>
    new OpenFgaRequestError({
      code: "network_error",
      detail: error instanceof Error ? error.message : "network request failed",
      retriable: true,
      ...(errorCause(error) ? { cause: errorCause(error) } : {}),
    }),
});

const parseJsonResponse = Result.fn({
  try: async (response: Response): Promise<unknown> => response.json(),
  catch: (error): OpenFgaRequestError =>
    new OpenFgaRequestError({
      code: "invalid_json_response",
      detail: error instanceof Error ? error.message : "response JSONをparseできません",
      retriable: false,
      ...(errorCause(error) ? { cause: errorCause(error) } : {}),
    }),
});

const serializeJson = Result.fn({
  try: (value: unknown): string => JSON.stringify(value),
  catch: (error): OpenFgaRequestError =>
    new OpenFgaRequestError({
      code: "request_serialization_error",
      detail: error instanceof Error ? error.message : "request JSONをserializeできません",
      retriable: false,
      ...(errorCause(error) ? { cause: errorCause(error) } : {}),
    }),
});

export type OpenFgaListUsersCompleteness = "assume_complete" | ((response: unknown) => boolean);

export type OpenFgaClientOptions = {
  apiUrl: string;
  storeId: string;
  authorizationModelId: string;
  organizationId: OrganizationId;
  token?: string;
  tokenSupplier?: FgaAccessTokenSupplier;
  fetch?: typeof globalThis.fetch;
  /**
   * ListUsersのHTTP応答だけではdeadline/max-resultsによる打切りを判定できないため既定は不完全扱い。
   * bounded model等で外部から完全性を保証できる場合のみ明示する。
   */
  listUsersCompleteness?: OpenFgaListUsersCompleteness;
  actionRequestId?: ActionRequestId;
  telemetry?: TelemetrySink;
};

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function consistencyValue(
  value: AuthorizationConsistency,
): "MINIMIZE_LATENCY" | "HIGHER_CONSISTENCY" {
  return value === "higher_consistency" ? "HIGHER_CONSISTENCY" : "MINIMIZE_LATENCY";
}

function normalizeTypedRef(type: string, id: string): string {
  const prefix = `${type}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

function parseObjectRef(
  value: AuthorizationObjectRef | string,
): { type: string; id: string } | null {
  const raw = String(value);
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { type: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

export function tenantScopedOpenFgaObject(organizationId: OrganizationId, object: string): string {
  const parsed = parseObjectRef(object);
  if (!parsed) return object;
  return `${parsed.type}:${encodeURIComponent(String(organizationId))}/${encodeURIComponent(
    parsed.id,
  )}`;
}

type OpenFgaObservedOperation = "check" | "list_users" | "read" | "write";

const OBSERVATION_METRIC = {
  check: "fga.check_latency_ms",
  list_users: "fga.list_users_latency_ms",
  read: "fga.read_latency_ms",
  write: "fga.write_latency_ms",
} as const;

/**
 * How a failed provider call relates to its side effect.
 * - `not_sent`: the request never reached the provider (token/serialization).
 * - `rejected`: the provider answered and did not apply it (429 / 4xx).
 * - `ambiguous`: the effect may or may not have been applied (network loss,
 *   timeout, 5xx). Mutations must not assume "not applied" in this case.
 */
export type OpenFgaFailureEffect = "not_sent" | "rejected" | "ambiguous";

export function openFgaFailureEffect(error: OpenFgaRequestError): OpenFgaFailureEffect {
  if (error.code === "network_error") return "ambiguous";
  if (error.code === "http_error") {
    const status = error.status ?? 0;
    return status >= 500 || status === 408 ? "ambiguous" : "rejected";
  }
  if (error.code === "invalid_json_response") return "ambiguous";
  return "not_sent";
}

export class OpenFgaClient {
  readonly authorizationModelId: string;
  readonly storeId: string;
  private readonly apiUrl: string;
  private readonly organizationId: OrganizationId;
  private readonly token?: string;
  private readonly tokenSupplier?: FgaAccessTokenSupplier;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly listUsersCompleteness?: OpenFgaListUsersCompleteness;
  private readonly actionRequestId?: ActionRequestId;
  private readonly telemetry?: TelemetrySink;

  constructor(options: OpenFgaClientOptions) {
    this.apiUrl = normalizeBaseUrl(options.apiUrl);
    this.storeId = options.storeId;
    this.authorizationModelId = options.authorizationModelId;
    this.organizationId = options.organizationId;
    this.token = options.token;
    this.tokenSupplier = options.tokenSupplier;
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.listUsersCompleteness = options.listUsersCompleteness;
    this.actionRequestId = options.actionRequestId;
    this.telemetry = options.telemetry;
  }

  /** Non-secret provider summary (API host, store, model) for admin display. */
  get providerSummary(): { apiHost: string; storeId: string; authorizationModelId: string } {
    return {
      apiHost: new URL(this.apiUrl).host,
      storeId: this.storeId,
      authorizationModelId: this.authorizationModelId,
    };
  }

  /** Logical `type:id` → tenant-scoped provider object for this client's organization. */
  providerObject(logicalObject: string): string {
    return tenantScopedOpenFgaObject(this.organizationId, logicalObject);
  }

  private emitObservation(
    operation: OpenFgaObservedOperation,
    startedAt: number,
    errorCode?: string,
  ): void {
    if (!this.telemetry) return;
    // check/list_users keep the M8 contract: only correlated (re-auth) calls emit.
    // Admin reads and relationship writes emit under a synthetic correlation.
    if (!this.actionRequestId && (operation === "check" || operation === "list_users")) return;
    const correlation = actionCorrelation({
      organizationId: this.organizationId,
      actionRequestId: this.actionRequestId ?? ("action:authorization-admin" as ActionRequestId),
      component: "fga",
      operation,
    });
    this.telemetry.emit(
      metricRecord({
        name: OBSERVATION_METRIC[operation],
        value: Math.max(0, Date.now() - startedAt),
        unit: "milliseconds",
        correlation,
      }),
    );
    if (errorCode) {
      this.telemetry.emit(
        metricRecord({
          name: "fga.error_total",
          value: 1,
          unit: "count",
          correlation,
          attributes: { errorCode },
        }),
      );
    }
  }

  private async resolveToken(): Result.ResultAsync<string | null, OpenFgaRequestError> {
    if (!this.tokenSupplier) return Result.succeed(this.token ?? null);
    const supplied = await this.tokenSupplier.getAccessToken();
    if (Result.isFailure(supplied)) {
      return Result.fail(
        new OpenFgaRequestError({
          code: supplied.error.code,
          detail: supplied.error.message,
          retriable: supplied.error.retriable,
        }),
      );
    }
    return Result.succeed(supplied.value);
  }

  private async postResponse(
    path: string,
    body: unknown,
  ): Result.ResultAsync<Response, OpenFgaRequestError> {
    const serialized = serializeJson(body);
    if (Result.isFailure(serialized)) return serialized;
    const token = await this.resolveToken();
    if (Result.isFailure(token)) return token;

    const response = await fetchRequest({
      fetch: this.fetchImplementation,
      url: `${this.apiUrl}${path}`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token.value ? { authorization: `Bearer ${token.value}` } : {}),
        },
        body: serialized.value,
      },
    });
    if (Result.isFailure(response)) return response;
    if (!response.value.ok) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "http_error",
          detail: `HTTP ${response.value.status}`,
          status: response.value.status,
          retriable: response.value.status === 429 || response.value.status >= 500,
        }),
      );
    }
    return response;
  }

  private async postJsonObject(
    path: string,
    body: unknown,
  ): Result.ResultAsync<Record<string, unknown>, OpenFgaRequestError> {
    const response = await this.postResponse(path, body);
    if (Result.isFailure(response)) return response;

    const parsed = await parseJsonResponse(response.value);
    if (Result.isFailure(parsed)) return parsed;
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "invalid_json_response",
          detail: "OpenFGA responseがJSON objectではありません",
          retriable: false,
        }),
      );
    }
    return Result.succeed(parsed.value as Record<string, unknown>);
  }

  private async getJsonObject(
    path: string,
  ): Result.ResultAsync<Record<string, unknown>, OpenFgaRequestError> {
    const token = await this.resolveToken();
    if (Result.isFailure(token)) return token;
    const response = await fetchRequest({
      fetch: this.fetchImplementation,
      url: `${this.apiUrl}${path}`,
      init: {
        method: "GET",
        headers: token.value ? { authorization: `Bearer ${token.value}` } : {},
      },
    });
    if (Result.isFailure(response)) return response;
    if (!response.value.ok) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "http_error",
          detail: `HTTP ${response.value.status}`,
          status: response.value.status,
          retriable: response.value.status === 429 || response.value.status >= 500,
        }),
      );
    }
    const parsed = await parseJsonResponse(response.value);
    if (Result.isFailure(parsed)) return parsed;
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "invalid_json_response",
          detail: "OpenFGA responseがJSON objectではありません",
          retriable: false,
        }),
      );
    }
    return Result.succeed(parsed.value as Record<string, unknown>);
  }

  /**
   * Exact tuple read (user + relation + logical object). Used to observe the
   * provider effect of a relationship mutation; it never scans the store.
   * Returns whether the tenant-scoped tuple is present.
   */
  async readTuple(input: {
    tuple: OpenFgaTupleKey;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, OpenFgaRequestError> {
    const startedAt = Date.now();
    const object = this.providerObject(input.tuple.object);
    const response = await this.postJsonObject(`/stores/${encodeURIComponent(this.storeId)}/read`, {
      tuple_key: { user: input.tuple.user, relation: input.tuple.relation, object },
      page_size: 1,
      consistency: consistencyValue(input.consistency),
    });
    if (Result.isFailure(response)) {
      this.emitObservation("read", startedAt, response.error.code);
      return response;
    }
    const tuples = response.value.tuples;
    if (!Array.isArray(tuples)) {
      const error = new OpenFgaRequestError({
        code: "invalid_read_response",
        detail: "Read responseにtuples配列がありません",
        retriable: false,
      });
      this.emitObservation("read", startedAt, error.code);
      return Result.fail(error);
    }
    this.emitObservation("read", startedAt);
    return Result.succeed(
      tuples.some((entry) => {
        if (typeof entry !== "object" || entry === null || !("key" in entry)) return false;
        const key = entry.key as Record<string, unknown> | null;
        return (
          key !== null &&
          key.user === input.tuple.user &&
          key.relation === input.tuple.relation &&
          key.object === object
        );
      }),
    );
  }

  /** Reads the configured (pinned) authorization model. Read-only; no model write exists. */
  async readAuthorizationModel(): Result.ResultAsync<
    { id: string; model: Record<string, unknown> },
    OpenFgaRequestError
  > {
    const response = await this.getJsonObject(
      `/stores/${encodeURIComponent(this.storeId)}/authorization-models/${encodeURIComponent(
        this.authorizationModelId,
      )}`,
    );
    if (Result.isFailure(response)) return response;
    const model = response.value.authorization_model;
    if (typeof model !== "object" || model === null || Array.isArray(model)) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "invalid_model_response",
          detail: "authorization_modelがありません",
          retriable: false,
        }),
      );
    }
    const record = model as Record<string, unknown>;
    return Result.succeed({
      id: typeof record.id === "string" ? record.id : this.authorizationModelId,
      model: record,
    });
  }

  async check(input: {
    user: string;
    relation: string;
    object: string;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, OpenFgaRequestError> {
    const startedAt = Date.now();
    const response = await this.postJsonObject(
      `/stores/${encodeURIComponent(this.storeId)}/check`,
      {
        authorization_model_id: this.authorizationModelId,
        tuple_key: {
          user: input.user,
          relation: input.relation,
          object: tenantScopedOpenFgaObject(this.organizationId, input.object),
        },
        ...(input.context ? { context: input.context } : {}),
        consistency: consistencyValue(input.consistency),
      },
    );
    if (Result.isFailure(response)) {
      this.emitObservation("check", startedAt, response.error.code);
      return response;
    }
    if (!("allowed" in response.value) || typeof response.value.allowed !== "boolean") {
      const error = new OpenFgaRequestError({
        code: "invalid_check_response",
        detail: "Check responseにboolean allowedがありません",
        retriable: false,
      });
      this.emitObservation("check", startedAt, error.code);
      return Result.fail(error);
    }
    this.emitObservation("check", startedAt);
    return Result.succeed(response.value.allowed);
  }

  async listUsers(input: {
    object: AuthorizationObjectRef;
    relation: RelationName;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, OpenFgaRequestError> {
    const startedAt = Date.now();
    const object = parseObjectRef(
      tenantScopedOpenFgaObject(this.organizationId, String(input.object)),
    );
    if (!object) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "invalid_object_ref",
          detail: `OpenFGA object refが不正です: ${String(input.object)}`,
          retriable: false,
        }),
      );
    }
    const response = await this.postJsonObject(
      `/stores/${encodeURIComponent(this.storeId)}/list-users`,
      {
        authorization_model_id: this.authorizationModelId,
        object,
        relation: String(input.relation),
        user_filters: [{ type: "user" }],
        ...(input.context ? { context: input.context } : {}),
        consistency: consistencyValue(input.consistency),
      },
    );
    if (Result.isFailure(response)) {
      this.emitObservation("list_users", startedAt, response.error.code);
      return response;
    }
    if (!("users" in response.value) || !Array.isArray(response.value.users)) {
      const error = new OpenFgaRequestError({
        code: "invalid_list_users_response",
        detail: "ListUsers responseにusers配列がありません",
        retriable: false,
      });
      this.emitObservation("list_users", startedAt, error.code);
      return Result.fail(error);
    }

    const userIds: UserId[] = [];
    let concreteUsersOnly = true;
    for (const user of response.value.users) {
      if (
        typeof user === "object" &&
        user !== null &&
        "object" in user &&
        typeof user.object === "object" &&
        user.object !== null &&
        "type" in user.object &&
        user.object.type === "user" &&
        "id" in user.object &&
        typeof user.object.id === "string"
      ) {
        userIds.push(normalizeTypedRef("user", user.object.id) as UserId);
      } else {
        concreteUsersOnly = false;
      }
    }

    const configuredComplete =
      this.listUsersCompleteness === "assume_complete"
        ? true
        : typeof this.listUsersCompleteness === "function"
          ? this.listUsersCompleteness(response.value)
          : false;
    this.emitObservation("list_users", startedAt);
    return Result.succeed({ userIds, complete: concreteUsersOnly && configuredComplete });
  }

  async writeTuples(input: {
    writes?: OpenFgaTupleKey[];
    deletes?: OpenFgaTupleKey[];
  }): Result.ResultAsync<void, OpenFgaRequestError> {
    const scope = (tuple: OpenFgaTupleKey): OpenFgaTupleKey => ({
      ...tuple,
      object: tenantScopedOpenFgaObject(this.organizationId, tuple.object),
    });
    const startedAt = Date.now();
    const response = await this.postResponse(`/stores/${encodeURIComponent(this.storeId)}/write`, {
      authorization_model_id: this.authorizationModelId,
      ...(input.writes?.length ? { writes: { tuple_keys: input.writes.map(scope) } } : {}),
      ...(input.deletes?.length ? { deletes: { tuple_keys: input.deletes.map(scope) } } : {}),
    });
    this.emitObservation(
      "write",
      startedAt,
      Result.isFailure(response) ? response.error.code : undefined,
    );
    return Result.isFailure(response) ? response : Result.succeed(undefined);
  }
}

function authorizationError(error: OpenFgaRequestError): AuthorizationProviderError {
  return new AuthorizationProviderError({
    provider: "openfga",
    code: error.code,
    retriable: error.retriable,
    detail: error.message,
    cause: error,
  });
}

function approverError(error: OpenFgaRequestError): ApproverResolverProviderError {
  return new ApproverResolverProviderError({
    provider: "openfga",
    code: error.code,
    retriable: error.retriable,
    detail: error.message,
    cause: error,
  });
}

export type OpenFgaActionRelationMapper = (actionType: ActionType) => RelationName;

export class OpenFgaActionAuthorizer implements ActionAuthorizer {
  constructor(
    private readonly client: OpenFgaClient,
    private readonly relationForAction: OpenFgaActionRelationMapper,
  ) {}

  async check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<AuthorizationDecision, AuthorizationProviderError> {
    const principal = input.request.authority.principal;
    const checked = await this.client.check({
      user: normalizeTypedRef(principal.type, String(principal.id)),
      relation: String(this.relationForAction(input.request.action.type)),
      object: normalizeTypedRef(
        String(input.request.action.resource.type),
        String(input.request.action.resource.id),
      ),
      context: { current_time: input.evaluatedAt },
      consistency: input.consistency,
    });
    if (Result.isFailure(checked)) return Result.fail(authorizationError(checked.error));
    if (!checked.value) {
      return Result.succeed({
        type: "deny",
        code: "fga_check_denied",
        reason: "Authority PrincipalはActionを実行するrelationを持っていません",
      });
    }
    return Result.succeed({
      type: "allow",
      evidence: {
        evaluatedAt: input.evaluatedAt,
        provider: "openfga",
        authorizationModelId: this.client.authorizationModelId,
        consistency: input.consistency,
      },
    });
  }
}

export class OpenFgaApproverResolver implements ApproverResolver {
  constructor(private readonly client: OpenFgaClient) {}

  async check(input: {
    target: ResolvedApproverTarget;
    userId: UserId;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, ApproverResolverProviderError> {
    if (input.target.type === "user") {
      return Result.succeed(String(input.target.userId) === String(input.userId));
    }
    const checked = await this.client.check({
      user: normalizeTypedRef("user", String(input.userId)),
      relation: String(input.target.relation),
      object: String(input.target.object),
      context: input.context,
      consistency: input.consistency,
    });
    return Result.isFailure(checked) ? Result.fail(approverError(checked.error)) : checked;
  }

  async list(input: {
    target: ResolvedApproverTarget;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
    if (input.target.type === "user") {
      return Result.succeed({ userIds: [input.target.userId], complete: true });
    }
    const listed = await this.client.listUsers({
      object: input.target.object,
      relation: input.target.relation,
      context: input.context,
      consistency: input.consistency,
    });
    return Result.isFailure(listed) ? Result.fail(approverError(listed.error)) : listed;
  }
}

export type OpenFgaTupleKey = {
  user: string;
  relation: string;
  object: string;
};

/** Organization DB/outboxからOpenFGA tuple projectionへ反映する最小adapter。 */
export class OpenFgaOrganizationProjector {
  constructor(private readonly client: OpenFgaClient) {}

  project(input: {
    writes?: OpenFgaTupleKey[];
    deletes?: OpenFgaTupleKey[];
  }): Result.ResultAsync<void, OpenFgaRequestError> {
    return this.client.writeTuples(input);
  }
}
