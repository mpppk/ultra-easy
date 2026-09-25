import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  ActionExecutorError,
  ActionExecutorRegistry,
  always,
  definePolicy,
  none,
  rule,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionExecutionGuaranteeLevel,
  ActionExecutionResult,
  ActionExecutor,
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
  type TrustedActionRequestContext,
} from "@app/approval-application";
import {
  createD1ActionRequestPersistence,
  D1ActionEventRepository,
  D1NotificationOutboxRepository,
  D1PublicApiRepository,
} from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";

const org = "organization:review-78" as OrganizationId;
const alice = "user:alice" as UserId;
const now = "2026-09-25T00:00:00.000Z";

const definition: ActionDefinition = {
  key: "definition:sync" as ActionDefinition["key"],
  version: 1,
  actionType: "ticket.sync" as ActionDefinition["actionType"],
  inputSchema: { key: "schema:sync" as ActionDefinition["inputSchema"]["key"], version: 1 },
  executorKey: "executor:sync" as ExecutorKey,
};

const schema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
  },
};

/** 1回目（受付時の認可）はallow、2回目（実行直前の再認可）はscenarioに従う。 */
class ScenarioAuthorizer implements ActionAuthorizer {
  private calls = 0;

  constructor(private readonly reauthorization: "allow" | "deny") {}

  async check(input: { evaluatedAt: string }) {
    this.calls += 1;
    const deny = this.calls > 1 && this.reauthorization === "deny";
    return Result.succeed<AuthorizationDecision>(
      deny
        ? { type: "deny", code: "authority_revoked", reason: "authority was revoked" }
        : {
            type: "allow",
            evidence: { evaluatedAt: input.evaluatedAt, consistency: "higher_consistency" },
          },
    );
  }
}

class ScenarioExecutor implements ActionExecutor {
  calls = 0;

  constructor(
    readonly guaranteeLevel: ActionExecutionGuaranteeLevel,
    private readonly outcome: "succeed" | "fail" | "timeout",
  ) {}

  async execute(): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    this.calls += 1;
    if (this.outcome === "fail") {
      return Result.fail(
        new ActionExecutorError({ code: "business_rule", retriable: false, detail: "rejected" }),
      );
    }
    if (this.outcome === "timeout") {
      return Result.fail(
        new ActionExecutorError({ code: "upstream_timeout", retriable: true, detail: "timeout" }),
      );
    }
    return Result.succeed({ status: "succeeded", output: { ticket: "T-1", updated: true } });
  }
}

function harness(input: { reauthorization?: "allow" | "deny"; executor?: ScenarioExecutor }) {
  const db = migratedSqliteD1();
  const executor = input.executor ?? new ScenarioExecutor("idempotent", "succeed");
  // #85: 本番と同じfactoryでD1依存（plan / event / result）を組み立て、resolverだけ差し替える。
  const service = new ActionRequestApplicationService({
    ...createD1ActionRequestPersistence(db, org),
    actionDefinitionResolver: { resolve: async () => Result.succeed(definition) },
    schemaResolver: { resolve: async () => Result.succeed(schema) },
    policyBindingResolver: {
      resolve: async () =>
        Result.succeed([
          {
            binding: {
              id: "binding:sync" as ApprovalPolicyBindingId,
              organizationId: org,
              policyKey: "policy:sync" as never,
              selector: { actionTypes: [definition.actionType] },
              enabled: true,
            },
            policyVersion: 1,
            policy: definePolicy({
              key: "policy:sync",
              name: "no approval",
              rules: [rule("default", { when: always(), flow: none() })],
            }),
          },
        ]),
    },
    authorizer: new ScenarioAuthorizer(input.reauthorization ?? "allow"),
    executor: new ActionExecutorRegistry({ [String(definition.executorKey)]: executor }),
    workflowStarter: { start: async () => Result.succeed({ workflowInstanceId: "unused" }) },
    idGenerator: { next: () => "action:sync-1" as ActionRequestId },
  });
  const principal: PrincipalRef = { type: "user", id: alice };
  const context: TrustedActionRequestContext = {
    actor: principal,
    authority: { principal },
    origin: { type: "api" },
    organization: { id: org },
    now,
  };
  const repository = new D1PublicApiRepository(db);
  const api = createPublicHttpApi({
    actionRequestApi: createActionRequestHttpApi({
      service,
      trustedContextProvider: { resolve: async () => Result.succeed(context) },
    }),
    readRepository: repository,
    decisionService: new ApprovalDecisionCommandService(repository, repository, {
      next: () => "command:unused",
    }),
    identityProvider: { authenticate: async () => Result.succeed(principal) },
    idempotencyRepository: repository,
    clock: { now: () => now },
  });
  const base = `https://api.test/v1/organizations/${encodeURIComponent(String(org))}/action-requests`;
  return {
    executor,
    async submit() {
      return api.fetch(
        new Request(base, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "submit-1" },
          body: JSON.stringify({
            action: {
              type: String(definition.actionType),
              resource: { type: "ticket", id: "T-1" },
              input: { priority: "high" },
            },
          }),
        }),
      );
    },
    async get() {
      const response = await api.fetch(
        new Request(`${base}/${encodeURIComponent("action:sync-1")}`),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { status: string; result?: Record<string, unknown> };
    },
    async requesterRecipients() {
      const outbox = new D1NotificationOutboxRepository(db);
      const entries = await outbox.listDispatchable("2099-01-01T00:00:00.000Z");
      if (Result.isFailure(entries)) return [];
      const completed = entries.value.find((entry) => entry.eventType === "action.completed");
      if (!completed) return [];
      const recipients = await outbox.resolveRecipients(completed);
      return Result.isSuccess(recipients) ? recipients.value.map(String) : [];
    },
    async events() {
      const listed = await new D1ActionEventRepository(db).listForAction({
        organizationId: org,
        actionRequestId: "action:sync-1" as ActionRequestId,
      });
      return Result.isSuccess(listed) ? listed.value.map((record) => record.event.type) : [];
    },
  };
}

describe("#86 承認不要（同期実行）経路のread model", () => {
  it("executed: 201応答とGETのstatus・resultが一致し、監査が残る", async () => {
    const h = harness({});
    const created = await h.submit();
    expect(created.status).toBe(201);
    const view = (await created.json()) as { status: string; result?: Record<string, unknown> };
    expect(view).toMatchObject({
      status: "executed",
      result: { status: "executed", output: { ticket: "T-1", updated: true } },
    });

    const read = await h.get();
    expect(read.status).toBe(view.status);
    expect(read.result).toEqual(view.result);
    expect(await h.events()).toEqual([
      "action.received",
      "action.authorized",
      "approval_plan.materialized",
      "action.reauthorized",
      "action.execution_started",
      "action.completed",
    ]);
    // #85: action.receivedが永続化され、requester宛て通知の宛先が解決できる
    expect(await h.requesterRecipients()).toEqual([String(alice)]);
  });

  it("authorization_revoked: 201応答とGETが一致し、Executorは呼ばれない", async () => {
    const h = harness({ reauthorization: "deny" });
    const created = await h.submit();
    expect(created.status).toBe(201);
    const view = (await created.json()) as { status: string; result?: Record<string, unknown> };
    expect(view.status).toBe("authorization_revoked");
    const read = await h.get();
    expect(read.status).toBe("authorization_revoked");
    expect(read.result).toEqual(view.result);
    expect(h.executor.calls).toBe(0);
  });

  it("execution_failed / execution_unknown: 失敗応答でもGETは終端状態を返す（executingのまま残らない）", async () => {
    const failed = harness({ executor: new ScenarioExecutor("idempotent", "fail") });
    expect((await failed.submit()).status).toBeGreaterThanOrEqual(400);
    expect(await failed.get()).toMatchObject({
      status: "execution_failed",
      result: { status: "execution_failed", code: "business_rule" },
    });

    const unknown = harness({
      executor: new ScenarioExecutor("best_effort_at_most_once", "timeout"),
    });
    expect((await unknown.submit()).status).toBeGreaterThanOrEqual(400);
    expect(await unknown.get()).toMatchObject({
      status: "execution_unknown",
      result: { status: "execution_unknown", code: "upstream_timeout" },
    });
    expect(unknown.executor.calls).toBe(1);
  });
});
