import { Result } from "@praha/byethrow";

import {
  UltraEasyError,
  type CompiledPolicy,
  type CompiledPolicyRule,
  type PolicyBindingView,
  type PrincipalRef,
  type UltraEasyClient,
} from "../client.ts";

type PolicyMethods = Pick<
  UltraEasyClient,
  "getPolicyBinding" | "proposePolicyBinding" | "approvalUrl" | "adminPolicyUrl"
>;

export type RemotePolicyOptions = {
  baseUrl: string;
  approvalUiBaseUrl: string;
  organizationId: string;
  principalId: string;
  accessToken: string;
  send?: (request: Request) => Promise<Response>;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: UltraEasyError["code"]): UltraEasyError {
  return new UltraEasyError(code, `ultra-easy ${code}`);
}

function responseError(status: number): UltraEasyError {
  if (status === 401 || status === 403) return error("forbidden");
  if (status === 404) return error("not_found");
  if (status === 400 || status === 422) return error("invalid_request");
  if (status === 409 || status === 412) return error("invalid_state");
  return error("platform_unavailable");
}

function policy(value: unknown): CompiledPolicy | null {
  if (!record(value) || !Array.isArray(value.rules)) return null;
  const rules: CompiledPolicyRule[] = [];
  for (const candidate of value.rules) {
    if (
      !record(candidate) ||
      typeof candidate.key !== "string" ||
      (candidate.actionType !== "knowledge.revision.publish" &&
        candidate.actionType !== "knowledge.page.archive") ||
      (candidate.approvers !== "space_owners" && candidate.approvers !== "page_owner") ||
      !record(candidate.when)
    )
      return null;
    const when = candidate.when;
    if (
      !(when.always === true && Object.keys(when).length === 1) &&
      !(when.requesterIsNot === "page_owner" && Object.keys(when).length === 1) &&
      !(
        typeof when.field === "string" &&
        typeof when.equals === "string" &&
        Object.keys(when).length === 2
      )
    )
      return null;
    rules.push(candidate as CompiledPolicyRule);
  }
  return { rules };
}

function validSpaceId(spaceId: string): boolean {
  return /^[A-Za-z0-9:_-]{1,128}$/.test(spaceId);
}

/** Request-scoped adapter for the governed application policy API (#199). */
export class RemotePolicyClient implements PolicyMethods {
  private readonly send: (request: Request) => Promise<Response>;

  constructor(private readonly options: RemotePolicyOptions) {
    this.send = options.send ?? ((request) => fetch(request));
  }

  private scoped(organizationId: string): Result.Result<string, UltraEasyError> {
    if (organizationId !== this.options.organizationId) return Result.fail(error("forbidden"));
    return Result.succeed(`/v1/organizations/${encodeURIComponent(organizationId)}`);
  }

  private async json(
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Result.ResultAsync<JsonRecord, UltraEasyError> {
    const response = await Result.try({
      try: () => {
        const headers = new Headers({ authorization: `Bearer ${this.options.accessToken}` });
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
    return Result.isSuccess(parsed) && record(parsed.value)
      ? Result.succeed(parsed.value)
      : Result.fail(error("platform_unavailable"));
  }

  private policyPath(base: string, spaceId: string): string {
    return `${base}/application-policies/knowledge_space/${encodeURIComponent(spaceId)}`;
  }

  async getPolicyBinding(input: { organizationId: string; spaceId: string }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (!validSpaceId(input.spaceId)) return Result.fail(error("invalid_request"));
    const loaded = await this.json(this.policyPath(base.value, input.spaceId));
    if (Result.isFailure(loaded)) return loaded;
    const value = loaded.value;
    const current = policy(value.policy);
    if (
      value.scopeType !== "knowledge_space" ||
      value.scopeId !== input.spaceId ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 0 ||
      !current
    )
      return Result.fail(error("platform_unavailable"));
    let pendingChange: PolicyBindingView["pendingChange"] = null;
    if (value.pendingChange !== null) {
      if (!record(value.pendingChange)) return Result.fail(error("platform_unavailable"));
      const proposed = policy(value.pendingChange.policy);
      if (typeof value.pendingChange.actionRequestId !== "string" || !proposed)
        return Result.fail(error("platform_unavailable"));
      pendingChange = {
        actionRequestId: value.pendingChange.actionRequestId,
        approvalUrl: new URL(
          `/action-requests/${encodeURIComponent(value.pendingChange.actionRequestId)}`,
          this.options.approvalUiBaseUrl,
        ).toString(),
        policy: proposed,
      };
    }
    return Result.succeed({
      spaceId: input.spaceId,
      version: value.version as number,
      policy: current,
      pendingChange,
    });
  }

  async proposePolicyBinding(input: {
    organizationId: string;
    spaceId: string;
    policy: CompiledPolicy;
    actor: PrincipalRef;
  }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (input.actor.id !== this.options.principalId) return Result.fail(error("forbidden"));
    if (!validSpaceId(input.spaceId) || !policy(input.policy))
      return Result.fail(error("invalid_request"));
    const current = await this.getPolicyBinding(input);
    if (Result.isFailure(current)) return current;
    const body = { baseVersion: current.value.version, policy: input.policy };
    const digest = await Result.try({
      try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))),
      catch: () => error("platform_unavailable"),
    });
    if (Result.isFailure(digest)) return digest;
    const hash = Array.from(new Uint8Array(digest.value), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const submitted = await this.json(`${base.value}/action-requests`, {
      method: "POST",
      idempotencyKey: `knowledge-policy:${input.spaceId}:${current.value.version}:${hash}`,
      body: {
        action: {
          type: "application.approval_policy.update",
          resource: { type: "knowledge_space", id: input.spaceId },
          input: body,
        },
      },
    });
    if (Result.isFailure(submitted)) return submitted;
    if (
      typeof submitted.value.id !== "string" ||
      submitted.value.organizationId !== input.organizationId ||
      !record(submitted.value.actor) ||
      submitted.value.actor.id !== input.actor.id
    )
      return Result.fail(error("platform_unavailable"));
    return this.getPolicyBinding(input);
  }

  approvalUrl(taskId: string): string {
    return new URL(
      `/approval-tasks/${encodeURIComponent(taskId)}`,
      this.options.approvalUiBaseUrl,
    ).toString();
  }

  adminPolicyUrl(spaceId: string): string {
    return new URL(
      `/admin/application-policies/knowledge_space/${encodeURIComponent(spaceId)}`,
      this.options.approvalUiBaseUrl,
    ).toString();
  }
}
