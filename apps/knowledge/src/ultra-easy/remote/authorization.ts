import { Result } from "@praha/byethrow";

import type { SpaceRole } from "@app/knowledge-core";

import { UltraEasyError, type PrincipalRef, type UltraEasyClient } from "../client.ts";

type AuthorizationMethods = Pick<
  UltraEasyClient,
  "listPrincipals" | "ensurePrincipal" | "spaceRoles" | "spaceMembers" | "grantSpaceRole"
>;

type AgentTokenProvider = () => Result.ResultAsync<string, UltraEasyError>;

export type RemoteAuthorizationOptions = {
  baseUrl: string;
  organizationId: string;
  /** Verified `user:<sub>` from the Knowledge session, never a request parameter. */
  principalId: string;
  /** API access token from that same encrypted session. */
  accessToken: string;
  /** The registered Knowledge M2M agent for governed role grants, including the first owner. */
  agentToken?: AgentTokenProvider;
  send?: (request: Request) => Promise<Response>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is SpaceRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

function error(code: UltraEasyError["code"]): UltraEasyError {
  return new UltraEasyError(code, `ultra-easy ${code}`);
}

function responseError(status: number): UltraEasyError {
  if (status === 401 || status === 403) return error("forbidden");
  if (status === 404) return error("not_found");
  if (status === 400 || status === 422) return error("invalid_request");
  if (status === 409) return error("invalid_state");
  return error("platform_unavailable");
}

function isPrincipal(value: unknown): value is PrincipalRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.startsWith("user:") &&
    value.id.length > "user:".length &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0
  );
}

function validSpaceId(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

/**
 * Request-scoped Knowledge client for the released principal and relationship
 * routes. No platform package is imported by Knowledge. Other UltraEasyClient
 * methods are added by the #183 run/policy adapters.
 */
export class RemoteAuthorizationClient implements AuthorizationMethods {
  private readonly send: (request: Request) => Promise<Response>;

  constructor(private readonly options: RemoteAuthorizationOptions) {
    this.send = options.send ?? ((request) => fetch(request));
  }

  private scoped(organizationId: string): Result.Result<string, UltraEasyError> {
    if (organizationId !== this.options.organizationId) return Result.fail(error("forbidden"));
    return Result.succeed(`/v1/organizations/${encodeURIComponent(this.options.organizationId)}`);
  }

  private async json(
    token: string,
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Result.ResultAsync<JsonRecord, UltraEasyError> {
    const response = await Result.try({
      try: () => {
        const headers = new Headers({ authorization: `Bearer ${token}` });
        if (init.body !== undefined) headers.set("content-type", "application/json");
        if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
        return this.send(
          new Request(new URL(path, this.options.baseUrl), {
            method: init.method ?? "GET",
            headers,
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          }),
        );
      },
      catch: () => error("platform_unavailable"),
    });
    if (Result.isFailure(response)) return response;
    if (!response.value.ok) return Result.fail(responseError(response.value.status));
    const parsed = await Result.try({
      try: (): Promise<unknown> => response.value.json(),
      catch: () => error("platform_unavailable"),
    });
    return Result.isSuccess(parsed) && isRecord(parsed.value)
      ? Result.succeed(parsed.value)
      : Result.fail(error("platform_unavailable"));
  }

  private async pages<T>(
    token: string,
    path: string,
    parse: (value: unknown) => T | null,
  ): Result.ResultAsync<T[], UltraEasyError> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 1_000; page++) {
      const suffix = `limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const loaded = await this.json(token, `${path}?${suffix}`);
      if (Result.isFailure(loaded)) return loaded;
      if (!Array.isArray(loaded.value.items) || loaded.value.items.length > 100)
        return Result.fail(error("platform_unavailable"));
      for (const raw of loaded.value.items) {
        const item = parse(raw);
        if (item === null) return Result.fail(error("platform_unavailable"));
        items.push(item);
      }
      const next = loaded.value.nextCursor;
      if (next === undefined) return Result.succeed(items);
      if (typeof next !== "string" || next.length === 0 || seen.has(next))
        return Result.fail(error("platform_unavailable"));
      seen.add(next);
      cursor = next;
    }
    return Result.fail(error("platform_unavailable"));
  }

  listPrincipals(organizationId: string) {
    const base = this.scoped(organizationId);
    if (Result.isFailure(base)) return Promise.resolve(base);
    return this.pages(this.options.accessToken, `${base.value}/principals`, (value) =>
      isPrincipal(value) ? value : null,
    );
  }

  async ensurePrincipal(input: { organizationId: string; principal: PrincipalRef }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (!isPrincipal(input.principal)) return Result.fail(error("invalid_request"));
    if (input.principal.id !== this.options.principalId) return Result.fail(error("forbidden"));
    const saved = await this.json(this.options.accessToken, `${base.value}/me/principal`, {
      method: "PUT",
      body: input.principal,
    });
    if (Result.isFailure(saved)) return saved;
    return saved.value.id === input.principal.id &&
      saved.value.displayName === input.principal.displayName
      ? Result.succeed(undefined)
      : Result.fail(error("platform_unavailable"));
  }

  async spaceRoles(input: { organizationId: string; principalId: string }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (input.principalId !== this.options.principalId) return Result.fail(error("forbidden"));
    const listed = await this.pages(
      this.options.accessToken,
      `${base.value}/me/space-roles`,
      (value): { spaceId: string; role: SpaceRole } | null =>
        isRecord(value) &&
        typeof value.spaceId === "string" &&
        validSpaceId(value.spaceId) &&
        isRole(value.role)
          ? { spaceId: value.spaceId, role: value.role }
          : null,
    );
    return Result.isFailure(listed)
      ? listed
      : Result.succeed(new Map(listed.value.map((item) => [item.spaceId, item.role])));
  }

  async spaceMembers(input: { organizationId: string; spaceId: string }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (!validSpaceId(input.spaceId)) return Result.fail(error("invalid_request"));
    return this.pages(
      this.options.accessToken,
      `${base.value}/spaces/${encodeURIComponent(input.spaceId)}/members`,
      (value): { principal: PrincipalRef; role: SpaceRole } | null => {
        const role = isRecord(value) ? value.role : null;
        return isPrincipal(value) && isRole(role)
          ? { principal: { id: value.id, displayName: value.displayName }, role }
          : null;
      },
    );
  }

  async grantSpaceRole(input: {
    organizationId: string;
    principalId: string;
    spaceId: string;
    role: SpaceRole;
  }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (
      !input.principalId.startsWith("user:") ||
      !validSpaceId(input.spaceId) ||
      !isRole(input.role)
    )
      return Result.fail(error("invalid_request"));
    if (!this.options.agentToken) return Result.fail(error("platform_unavailable"));
    const agent = await this.options.agentToken();
    if (Result.isFailure(agent)) return agent;
    const submitted = await this.json(agent.value, `${base.value}/action-requests`, {
      method: "POST",
      idempotencyKey: crypto.randomUUID(),
      body: {
        action: {
          type: "application.relationship.update",
          resource: { type: "knowledge_space", id: input.spaceId },
          input: {
            operation: "write",
            tuple: {
              user: input.principalId,
              relation: input.role,
              object: `knowledge_space:${input.spaceId}`,
            },
          },
        },
      },
    });
    if (Result.isFailure(submitted)) return submitted;
    const result = submitted.value.result;
    const output = isRecord(result) ? result.output : null;
    const relationship = isRecord(output) ? output.relationship : null;
    return submitted.value.status === "executed" &&
      isRecord(relationship) &&
      relationship.effectConfirmed === true
      ? Result.succeed(undefined)
      : Result.fail(error("invalid_state"));
  }
}
