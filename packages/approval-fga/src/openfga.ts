import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import { ApproverResolverProviderError, AuthorizationProviderError } from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionRequest,
  ActionType,
  ApproverCandidateList,
  ApproverResolver,
  AuthorizationConsistency,
  AuthorizationDecision,
  AuthorizationObjectRef,
  RelationName,
  ResolvedApproverTarget,
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
  token?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * ListUsersのHTTP応答だけではdeadline/max-resultsによる打切りを判定できないため既定は不完全扱い。
   * bounded model等で外部から完全性を保証できる場合のみ明示する。
   */
  listUsersCompleteness?: OpenFgaListUsersCompleteness;
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

function parseObjectRef(value: AuthorizationObjectRef): { type: string; id: string } | null {
  const raw = String(value);
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { type: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

export class OpenFgaClient {
  readonly authorizationModelId: string;
  private readonly apiUrl: string;
  private readonly storeId: string;
  private readonly token?: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly listUsersCompleteness?: OpenFgaListUsersCompleteness;

  constructor(options: OpenFgaClientOptions) {
    this.apiUrl = normalizeBaseUrl(options.apiUrl);
    this.storeId = options.storeId;
    this.authorizationModelId = options.authorizationModelId;
    this.token = options.token;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.listUsersCompleteness = options.listUsersCompleteness;
  }

  private async postResponse(
    path: string,
    body: unknown,
  ): Result.ResultAsync<Response, OpenFgaRequestError> {
    const serialized = serializeJson(body);
    if (Result.isFailure(serialized)) return serialized;

    const response = await fetchRequest({
      fetch: this.fetchImplementation,
      url: `${this.apiUrl}${path}`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
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

  async check(input: {
    user: string;
    relation: string;
    object: string;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, OpenFgaRequestError> {
    const response = await this.postJsonObject(`/stores/${encodeURIComponent(this.storeId)}/check`, {
      authorization_model_id: this.authorizationModelId,
      tuple_key: {
        user: input.user,
        relation: input.relation,
        object: input.object,
      },
      ...(input.context ? { context: input.context } : {}),
      consistency: consistencyValue(input.consistency),
    });
    if (Result.isFailure(response)) return response;
    if (!("allowed" in response.value) || typeof response.value.allowed !== "boolean") {
      return Result.fail(
        new OpenFgaRequestError({
          code: "invalid_check_response",
          detail: "Check responseにboolean allowedがありません",
          retriable: false,
        }),
      );
    }
    return Result.succeed(response.value.allowed);
  }

  async listUsers(input: {
    object: AuthorizationObjectRef;
    relation: RelationName;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, OpenFgaRequestError> {
    const object = parseObjectRef(input.object);
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
    if (Result.isFailure(response)) return response;
    if (!("users" in response.value) || !Array.isArray(response.value.users)) {
      return Result.fail(
        new OpenFgaRequestError({
          code: "invalid_list_users_response",
          detail: "ListUsers responseにusers配列がありません",
          retriable: false,
        }),
      );
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
    return Result.succeed({ userIds, complete: concreteUsersOnly && configuredComplete });
  }

  async writeTuples(input: {
    writes?: OpenFgaTupleKey[];
    deletes?: OpenFgaTupleKey[];
  }): Result.ResultAsync<void, OpenFgaRequestError> {
    const response = await this.postResponse(`/stores/${encodeURIComponent(this.storeId)}/write`, {
      authorization_model_id: this.authorizationModelId,
      ...(input.writes?.length ? { writes: { tuple_keys: input.writes } } : {}),
      ...(input.deletes?.length ? { deletes: { tuple_keys: input.deletes } } : {}),
    });
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
