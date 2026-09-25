import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import { describe, expect, it } from "vite-plus/test";

import {
  ActionDefinitionResolverError,
  AuthorizationProviderError,
  always,
  definePolicy,
  none,
  rule,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionRequestId,
  ApprovalPolicyBindingId,
  AuthorizationDecision,
  ExecutorKey,
  OrganizationId,
  PrincipalRef,
  UserId,
} from "@app/approval-core";

import {
  ActionRequestApplicationService,
  ApprovalDecisionCommandService,
  createActionRequestHttpApi,
  createPublicHttpApi,
  PublicApiRepositoryError,
  type ApprovalReadRepository,
  type TrustedActionRequestContext,
} from "./index.ts";

const org = "organization:http" as OrganizationId;
const alice = "user:alice" as UserId;
const principal: PrincipalRef = { type: "user", id: alice };
const internalSecret = "D1_ERROR: no such table secret_internal_table";

const definition: ActionDefinition = {
  key: "definition:http" as ActionDefinition["key"],
  version: 1,
  actionType: "ticket.update" as ActionDefinition["actionType"],
  inputSchema: { key: "schema:http" as ActionDefinition["inputSchema"]["key"], version: 1 },
  executorKey: "executor:http" as ExecutorKey,
};

const schema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
  },
};

function harness(
  input: {
    definitions?: "published" | "missing" | "d1_down";
    authorizer?: "allow" | "misconfigured";
    readRepository?: Partial<ApprovalReadRepository>;
  } = {},
) {
  const authorizer: ActionAuthorizer = {
    async check(check: { evaluatedAt: string }) {
      if (input.authorizer === "misconfigured") {
        return Result.fail(
          new AuthorizationProviderError({
            provider: "openfga",
            code: "fga_validation_error",
            retriable: false,
            detail: `relation undefined: ${internalSecret}`,
          }),
        );
      }
      return Result.succeed<AuthorizationDecision>({
        type: "allow",
        evidence: { evaluatedAt: check.evaluatedAt, consistency: "minimize_latency" },
      });
    },
  };
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: {
      async resolve() {
        if (input.definitions === "d1_down") {
          return Result.fail(
            new ActionDefinitionResolverError("d1_unavailable", true, internalSecret),
          );
        }
        return Result.succeed(input.definitions === "missing" ? null : definition);
      },
    },
    schemaResolver: { resolve: async () => Result.succeed(schema) },
    policyBindingResolver: {
      resolve: async () =>
        Result.succeed([
          {
            binding: {
              id: "binding:http" as ApprovalPolicyBindingId,
              organizationId: org,
              policyKey: "policy:http" as never,
              selector: { actionTypes: [definition.actionType] },
              enabled: true,
            },
            policyVersion: 1,
            policy: definePolicy({
              key: "policy:http",
              name: "none",
              rules: [rule("default", { when: always(), flow: none() })],
            }),
          },
        ]),
    },
    authorizer,
    executor: {
      guaranteeLevel: "idempotent",
      execute: async () => Result.succeed({ status: "succeeded" as const }),
    },
    planRepository: {
      save: async () => ({ type: "created" as const }),
      load: async () => ({ type: "not_found" as const }),
      loadForWorkflow: async () => ({ type: "not_found" as const }),
    } as never,
    eventRepository: new InMemoryActionAuditStore(),
    resultRepository: new InMemoryActionAuditStore(),
    workflowStarter: { start: async () => Result.succeed({ workflowInstanceId: "unused" }) },
    idGenerator: { next: () => "action:http" as ActionRequestId },
  });
  const context: TrustedActionRequestContext = {
    actor: principal,
    authority: { principal },
    origin: { type: "api" },
    organization: { id: org },
    now: "2026-09-25T00:00:00.000Z",
  };
  const readRepository = {
    getActionRequest: async () =>
      Result.fail(
        new PublicApiRepositoryError("public_api_repository_error", true, internalSecret),
      ),
    ...input.readRepository,
  } as unknown as ApprovalReadRepository;
  const store = new Map<string, unknown>();
  const api = createPublicHttpApi({
    actionRequestApi: createActionRequestHttpApi({
      service,
      trustedContextProvider: { resolve: async () => Result.succeed(context) },
    }),
    readRepository,
    decisionService: new ApprovalDecisionCommandService(readRepository, {} as never, {
      next: () => "command:1",
    }),
    identityProvider: { authenticate: async () => Result.succeed(principal) },
    idempotencyRepository: {
      async reserve(record) {
        store.set(record.key, record);
        return Result.succeed({ type: "acquired" as const, record });
      },
      async complete(record) {
        return Result.succeed({ ...record, status: "completed" } as never);
      },
      async release() {
        return Result.succeed(undefined);
      },
    },
    clock: { now: () => "2026-09-25T00:00:00.000Z" },
  });
  return api;
}

function submit(api: ReturnType<typeof harness>, orgSegment = "organization%3Ahttp") {
  return api.fetch(
    new Request(`https://api.test/v1/organizations/${orgSegment}/action-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "submit-1" },
      body: JSON.stringify({
        action: {
          type: "ticket.update",
          resource: { type: "ticket", id: "T-1" },
          input: { ticketId: "T-1" },
        },
      }),
    }),
  );
}

describe("#96 path parameterのdecode", () => {
  it("不正なpercent-encodingは500ではなく400 invalid_path_parameterになる", async () => {
    const api = harness();
    const malformed = "%E0%A4%A";
    const responses = await Promise.all([
      submit(api, malformed),
      api.fetch(new Request(`https://api.test/v1/organizations/${malformed}/action-requests/x`)),
      api.fetch(
        new Request(
          `https://api.test/v1/organizations/organization%3Ahttp/action-requests/${malformed}`,
        ),
      ),
      api.fetch(
        new Request(
          `https://api.test/v1/organizations/organization%3Ahttp/approval-tasks/${malformed}/decisions`,
          { method: "POST", headers: { "idempotency-key": "d" }, body: "{}" },
        ),
      ),
      api.fetch(
        new Request(
          `https://api.test/v1/organizations/organization%3Ahttp/approval-commands/${malformed}`,
        ),
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("invalid_path_parameter");
      expect(body).not.toContain("URIError");
    }
  });
});

describe("#93 HTTP error mapping", () => {
  it("未知のaction typeは503ではなく422 action_type_not_found", async () => {
    const response = await submit(harness({ definitions: "missing" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "action_type_not_found" });
  });

  it("FGAの設定不備（非retriable）は409ではなく500で、providerのmessageを返さない", async () => {
    const response = await submit(harness({ authorizer: "misconfigured" }));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("authorization_provider_failed");
    expect(body).not.toContain(internalSecret);
  });

  it("D1障害は503で、D1のmessageを返さない（submit / read）", async () => {
    const submitted = await submit(harness({ definitions: "d1_down" }));
    expect(submitted.status).toBe(503);
    expect(await submitted.text()).not.toContain(internalSecret);

    const read = await harness().fetch(
      new Request("https://api.test/v1/organizations/organization%3Ahttp/action-requests/x"),
    );
    expect(read.status).toBe(503);
    const body = await read.text();
    expect(body).toContain("public_api_repository_error");
    expect(body).not.toContain(internalSecret);
  });
});
