import { Result } from "@praha/byethrow";
import { InMemoryActionAuditStore } from "@app/approval-core/testing";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  AuthorizationProviderError,
  DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
  always,
  approve,
  definePolicy,
  eq,
  field,
  literal,
  none,
  object,
  parallelQuorum,
  relation,
  rule,
  serial,
  user,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  ApprovalPolicyBindingId,
  AuthorizationRelationshipReadRepository,
  AlwaysCondition,
  Condition,
  ExecutorKey,
  FlowDefinition,
  MaterializedPlanRepository,
  OrganizationId,
  RelationshipListFilter,
  SchemaKey,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";

import {
  ActionRequestApplicationService,
  AuthorizationExplainService,
  createAuthorizationAdminHttpApi,
  HttpTrustedContextError,
  type AuthorizationAdminAccessChecker,
  type AuthorizationAdminCaller,
  type AuthorizationExplainResult,
  type AuthorizationTargetDescriber,
} from "./index.ts";

const organizationId = "organization:tenant-a" as OrganizationId;
const viewer = "user:viewer" as UserId;
const outsider = "user:outsider" as UserId;
const now = "2026-09-24T00:00:00.000Z";

const ticketSchema = {
  "~standard": {
    version: 1,
    vendor: "m9-test",
    validate(value: unknown) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { issues: [{ message: "inputはobjectである必要があります" }] };
      }
      const ticketId = (value as Record<string, unknown>).ticketId;
      if (typeof ticketId !== "string" || ticketId.length === 0) {
        return { issues: [{ message: "ticketIdが必要です", path: ["ticketId"] }] };
      }
      return { value: { ticketId } };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

const definition: ActionDefinition = {
  key: "ticket-update" as ActionDefinitionKey,
  version: 1,
  actionType: "ticket.update" as ActionDefinition["actionType"],
  inputSchema: { key: "ticket-update" as SchemaKey, version: 1 },
  executorKey: "staging" as ExecutorKey,
};

class Recorder {
  saves = 0;
  workflows = 0;
  executions = 0;
  authorizations = 0;
}

class FakeAuthorizer implements ActionAuthorizer {
  constructor(
    private readonly recorder: Recorder,
    private readonly mode: "allow" | "deny" | "error",
  ) {}

  async check() {
    this.recorder.authorizations += 1;
    if (this.mode === "error") {
      return Result.fail(
        new AuthorizationProviderError({
          provider: "openfga",
          code: "http_error",
          retriable: true,
          detail: "HTTP 503 token=secret-should-not-leak",
        }),
      );
    }
    return Result.succeed(
      this.mode === "allow"
        ? {
            type: "allow" as const,
            evidence: {
              evaluatedAt: now,
              consistency: "minimize_latency" as const,
              provider: "openfga",
              authorizationModelId: "model-1",
            },
          }
        : { type: "deny" as const, code: "fga_check_denied", reason: "no relation" },
    );
  }
}

function binding(
  flow: FlowDefinition,
  when: Condition | AlwaysCondition = always(),
): VersionedApprovalPolicyBinding {
  return {
    binding: {
      id: "binding:ticket" as ApprovalPolicyBindingId,
      organizationId,
      policyKey: "policy:ticket" as VersionedApprovalPolicyBinding["binding"]["policyKey"],
      selector: { actionTypes: [definition.actionType] },
      enabled: true,
    },
    policyVersion: 2,
    policy: definePolicy({
      key: "policy:ticket",
      name: "Ticket",
      rules: [rule("default", { when, flow })],
    }),
  };
}

function service(input: {
  recorder: Recorder;
  authorization?: "allow" | "deny" | "error";
  bindings?: VersionedApprovalPolicyBinding[];
}) {
  return new ActionRequestApplicationService({
    actionDefinitionResolver: {
      resolve: async (type) =>
        Result.succeed(String(type) === String(definition.actionType) ? definition : null),
    },
    schemaResolver: { resolve: async () => Result.succeed(ticketSchema) },
    policyBindingResolver: {
      resolve: async () => Result.succeed(input.bindings ?? [binding(none())]),
    },
    authorizer: new FakeAuthorizer(input.recorder, input.authorization ?? "allow"),
    executor: {
      guaranteeLevel: "idempotent",
      execute: async () => {
        input.recorder.executions += 1;
        return Result.succeed({ status: "succeeded" as const });
      },
    },
    eventRepository: new InMemoryActionAuditStore(),
    resultRepository: new InMemoryActionAuditStore(),
    planRepository: {
      save: async () => {
        input.recorder.saves += 1;
        return { type: "created" as const };
      },
      loadForWorkflow: async () => ({ type: "not_found" as const }),
    } as unknown as MaterializedPlanRepository,
    workflowStarter: {
      start: async () => {
        input.recorder.workflows += 1;
        return Result.succeed({ workflowInstanceId: "wf" });
      },
    },
    idGenerator: { next: () => "action:simulated" as ActionRequestId },
  });
}

const describer: AuthorizationTargetDescriber = {
  describe: ({ action }) =>
    String(action.type) === "ticket.update"
      ? {
          relation: "can_execute",
          logicalObject: `ticket:${String(action.resource.id)}`,
          providerObject: `ticket:organization%3Atenant-a/${String(action.resource.id)}`,
          authorizationModelId: "model-1",
        }
      : null,
  providerObject: ({ organizationId: org, logicalObject }) => {
    const [type, id] = logicalObject.split(":");
    return `${type}:${encodeURIComponent(String(org))}/${id}`;
  },
};

function accessChecker(mode: "ok" | "error" = "ok"): AuthorizationAdminAccessChecker {
  return {
    check: async ({ caller, permission }) => {
      if (mode === "error") {
        return Result.fail(
          new AuthorizationProviderError({
            provider: "openfga",
            code: "network_error",
            retriable: true,
            detail: "down",
          }),
        );
      }
      return Result.succeed(
        String(caller.principal.id) === String(viewer) && permission === "viewer",
      );
    },
  };
}

function api(input: {
  recorder?: Recorder;
  authorization?: "allow" | "deny" | "error";
  bindings?: VersionedApprovalPolicyBinding[];
  access?: "ok" | "error";
  relationships?: AuthorizationRelationshipReadRepository;
  simulatableAttributes?: string[];
}) {
  const recorder = input.recorder ?? new Recorder();
  const explainService = new AuthorizationExplainService({
    service: service({
      recorder,
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...(input.bindings ? { bindings: input.bindings } : {}),
    }),
    describer,
    clock: { now: () => now },
    ...(input.simulatableAttributes ? { simulatableAttributes: input.simulatableAttributes } : {}),
  });
  return createAuthorizationAdminHttpApi({
    callerResolver: {
      resolve: async (request) => {
        const subject = request.headers.get("x-test-user");
        if (!subject) {
          return Result.fail(new HttpTrustedContextError(401, "bearer_token_missing", "missing"));
        }
        const caller: AuthorizationAdminCaller = {
          organizationId,
          principal: { type: "user", id: subject as UserId },
        };
        return Result.succeed(caller);
      },
    },
    accessChecker: accessChecker(input.access),
    explainService,
    relationships:
      input.relationships ??
      ({
        list: async () => Result.succeed({ items: [], nextCursor: null }),
        get: async () => Result.succeed(null),
        listAudit: async () => Result.succeed({ items: [], nextCursor: null }),
      } satisfies AuthorizationRelationshipReadRepository),
    describer,
    modelInspector: {
      inspect: async () =>
        Result.succeed({
          activeModelId: "model-1",
          provider: { apiHost: "fga.example", storeId: "store-1" },
          schemaVersion: "1.1",
          typeDefinitions: [],
          conditions: [],
          providerChecksum: "sha256:a",
          source: {
            path: "packages/approval-fga/openfga/model.fga",
            testsPath: "packages/approval-fga/openfga/store.fga.yaml",
            checksum: "sha256:a",
            matchesProvider: true,
            revision: null,
          },
          readOnly: true as const,
        }),
    },
    catalog: DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
    provider: { apiHost: "fga.example", storeId: "store-1", authorizationModelId: "model-1" },
  });
}

function request(
  path: string,
  init: { method?: string; user?: string | null; body?: unknown } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.user !== null) headers.set("x-test-user", init.user ?? String(viewer));
  return new Request(`https://api.example${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const explainBody = (input: unknown = { ticketId: "T-1" }) => ({
  principal: { type: "user", id: "user:alice" },
  action: { type: "ticket.update", resource: { type: "ticket", id: "T-1" }, input },
});

async function explain(
  handler: ReturnType<typeof api>,
  body: unknown = explainBody(),
): Promise<AuthorizationExplainResult> {
  const response = await handler.fetch(
    request("/v1/admin/authorization/explain", { method: "POST", body }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AuthorizationExplainResult;
}

describe("Authorization Admin API access (AC-M9-001 / AC-M9-010)", () => {
  it("viewer can read; non-viewer gets 403; unauthenticated 401; provider error fails closed 503", async () => {
    const handler = api({});
    for (const path of [
      "/v1/admin/authorization/relationships",
      "/v1/admin/authorization/model",
      "/v1/admin/authorization/catalog",
      "/v1/admin/authorization/audit",
    ]) {
      expect((await handler.fetch(request(path))).status, path).toBe(200);
      expect((await handler.fetch(request(path, { user: String(outsider) }))).status, path).toBe(
        403,
      );
      expect((await handler.fetch(request(path, { user: null }))).status, path).toBe(401);
    }
    expect(
      (
        await handler.fetch(
          request("/v1/admin/authorization/explain", {
            method: "POST",
            user: String(outsider),
            body: explainBody(),
          }),
        )
      ).status,
    ).toBe(403);
    const down = api({ access: "error" });
    const failed = await down.fetch(request("/v1/admin/authorization/relationships"));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "authorization_admin_check_failed" });
  });

  it("session reports the caller and permissions without requiring viewer", async () => {
    const handler = api({});
    const response = await handler.fetch(
      request("/v1/admin/authorization/session", { user: String(outsider) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizationId: String(organizationId),
      principal: { type: "user", id: String(outsider) },
      permissions: { viewer: false, editor: false },
      provider: null,
    });
  });

  it("exposes no write endpoints for relationships or the model (AC-M9-004 / AC-M9-008)", async () => {
    const handler = api({});
    for (const [method, path] of [
      ["POST", "/v1/admin/authorization/relationships"],
      ["DELETE", "/v1/admin/authorization/relationships/tuple:1"],
      ["PUT", "/v1/admin/authorization/model"],
      ["POST", "/v1/admin/authorization/model"],
      ["DELETE", "/v1/admin/authorization/model"],
    ] as const) {
      const response = await handler.fetch(request(path, { method, body: {} }));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("relationships are listed for the caller organization only; query cannot select another org", async () => {
    const seen: RelationshipListFilter[] = [];
    const handler = api({
      relationships: {
        list: async (filter) => {
          seen.push(filter);
          return Result.succeed({ items: [], nextCursor: null });
        },
        get: async () => Result.succeed(null),
        listAudit: async () => Result.succeed({ items: [], nextCursor: null }),
      },
    });
    const response = await handler.fetch(
      request(
        "/v1/admin/authorization/relationships?organizationId=organization:tenant-b&subject=user:alice&limit=10",
      ),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ organizationId, subject: "user:alice", limit: 10 }]);
    expect(
      (await handler.fetch(request("/v1/admin/authorization/relationships?limit=1000"))).status,
    ).toBe(400);
    expect(
      (await handler.fetch(request("/v1/admin/authorization/relationships?syncStatus=done")))
        .status,
    ).toBe(400);
  });
});

describe("Explorer explain (AC-M9-002 / AC-M9-002a)", () => {
  it("allowed + no approval, with relation / objects / model and zero side effects", async () => {
    const recorder = new Recorder();
    const result = await explain(api({ recorder }));
    expect(result).toMatchObject({
      effectiveOutcome: "allowed_no_approval",
      caller: { type: "user", id: String(viewer) },
      simulatedPrincipal: { type: "user", id: "user:alice" },
      authorization: {
        outcome: "allow",
        relation: "can_execute",
        logicalObject: "ticket:T-1",
        providerObject: "ticket:organization%3Atenant-a/T-1",
        consistency: "minimize_latency",
        authorizationModelId: "model-1",
      },
      normalizedInput: { ticketId: "T-1" },
      approvalFlow: { requiresApproval: false, root: { type: "none" } },
      proof: null,
    });
    expect(recorder).toMatchObject({ saves: 0, workflows: 0, executions: 0, authorizations: 1 });
  });

  it("approval required returns the materialized flow structure (serial + quorum)", async () => {
    const recorder = new Recorder();
    const flow = serial(
      approve({
        key: "manager",
        approver: relation({ object: object("team", literal("finance")), relation: "manager" }),
      }),
      parallelQuorum(
        1,
        approve({ key: "finance", approver: user(literal("user:bob")) }),
        approve({ key: "security", approver: user(literal("user:carol")) }),
      ),
    );
    const result = await explain(api({ recorder, bindings: [binding(flow)] }));
    expect(result.effectiveOutcome).toBe("allowed_requires_approval");
    expect(result.applicablePolicies).toEqual([
      {
        bindingId: "binding:ticket",
        policyKey: "policy:ticket",
        policyVersion: 2,
        matchedRuleKey: "default",
        outcome: "flow",
      },
    ]);
    const root = result.approvalFlow?.root;
    assert(root?.type === "serial");
    expect(root.children[0]).toMatchObject({ type: "approval", stepKey: "manager" });
    expect(root.children[1]).toMatchObject({ type: "quorum", required: 1, total: 2 });
    expect(recorder).toMatchObject({ saves: 0, workflows: 0, executions: 0 });
  });

  it("deny is distinct from no-approval", async () => {
    const result = await explain(api({ authorization: "deny" }));
    expect(result).toMatchObject({
      effectiveOutcome: "deny",
      authorization: { outcome: "deny", code: "fga_check_denied" },
      approvalFlow: null,
    });
  });

  it("provider outage is evaluation_error and never leaks provider detail", async () => {
    const result = await explain(api({ authorization: "error" }));
    expect(result).toMatchObject({
      effectiveOutcome: "evaluation_error",
      authorization: { outcome: "error" },
      error: { code: "authorization_provider_failed" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-should-not-leak");
  });

  it("missing or invalid action.input is evaluation_error with schema issues (not no-approval)", async () => {
    const recorder = new Recorder();
    const handler = api({ recorder });
    const missing = await explain(handler, {
      principal: { type: "user", id: "user:alice" },
      action: { type: "ticket.update", resource: { type: "ticket", id: "T-1" } },
    });
    expect(missing).toMatchObject({
      effectiveOutcome: "evaluation_error",
      authorization: { outcome: "not_evaluated" },
      error: { code: "action_input_validation_failed" },
    });
    const invalid = await explain(handler, explainBody({ ticketId: "" }));
    expect(invalid).toMatchObject({
      effectiveOutcome: "evaluation_error",
      error: {
        code: "action_input_validation_failed",
        issues: [{ message: "ticketIdが必要です", path: "ticketId" }],
      },
    });
    expect(recorder.authorizations).toBe(0);
  });

  it("missing required evaluation attribute is evaluation_error", async () => {
    const result = await explain(
      api({
        bindings: [
          binding(
            approve({ key: "risk", approver: user(literal("user:bob")) }),
            eq(field("attributes.riskLevel"), literal("high")),
          ),
        ],
      }),
    );
    expect(result).toMatchObject({
      effectiveOutcome: "evaluation_error",
      authorization: { outcome: "allow" },
      error: { code: "policy_evaluation_failed" },
    });
  });

  it("unknown action type is evaluation_error", async () => {
    const result = await explain(api({}), {
      principal: { type: "user", id: "user:alice" },
      action: { type: "ticket.delete", resource: { type: "ticket", id: "T-1" }, input: {} },
    });
    expect(result).toMatchObject({
      effectiveOutcome: "evaluation_error",
      error: { code: "action_type_not_found" },
    });
  });

  it("arbitrary trusted context cannot be injected; only allow-listed overrides", async () => {
    const handler = api({ simulatableAttributes: ["riskLevel"] });
    for (const body of [
      { ...explainBody(), organizationId: "organization:tenant-b" },
      { ...explainBody(), context: { actor: { type: "user", id: "user:root" } } },
      { ...explainBody(), principal: { type: "user", id: "user:alice", admin: true } },
    ]) {
      const response = await handler.fetch(
        request("/v1/admin/authorization/explain", { method: "POST", body }),
      );
      expect(response.status).toBe(400);
    }
    const rejected = await explain(handler, {
      ...explainBody(),
      simulationOverrides: { organization: { id: "organization:tenant-b" } },
    });
    expect(rejected).toMatchObject({
      effectiveOutcome: "evaluation_error",
      error: { code: "simulation_override_not_allowed" },
    });

    const withOverride = await explain(
      api({
        simulatableAttributes: ["riskLevel"],
        bindings: [
          binding(
            approve({ key: "risk", approver: user(literal("user:bob")) }),
            eq(field("attributes.riskLevel"), literal("high")),
          ),
        ],
      }),
      { ...explainBody(), simulationOverrides: { riskLevel: "high" } },
    );
    expect(withOverride.effectiveOutcome).toBe("allowed_requires_approval");
  });
});
