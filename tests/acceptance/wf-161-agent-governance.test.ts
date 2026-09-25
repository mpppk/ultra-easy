import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ActionType,
  AgentId,
  Condition,
  DelegationGrantId,
  OrganizationId,
} from "@app/approval-core";
import type { CapabilityPolicy, LlmProvider, ResourceLimits } from "@app/workflow-application";
import { createWorkflowPlatform } from "@app/workflow-platform";
import type {
  CapabilityGrant,
  ProgramNodeReference,
  WorkflowNode,
  WorkflowRunId,
} from "@app/workflow-core";
import { definition, edges, f, graph, id, lit, n, obj } from "@app/workflow-core/testing";
import { QuickJsSandbox } from "@app/workflow-sandbox";
import { nodeQuickJsModule } from "@app/workflow-sandbox/node";

import {
  ALICE,
  ORG,
  RecordingApprovalStarter,
  RecordingExecutor,
  TableAuthorizer,
  createWorkflowHarness,
} from "../workflow/harness.ts";

const SECRET = "sk-live-0123456789abcdefghijklmnop";

class FakeLlm implements LlmProvider {
  readonly name = "fake-llm";
  readonly prompts: string[] = [];
  toolCalls = false;

  async complete(input: {
    model: string;
    system?: string;
    prompt: string;
    maxOutputTokens: number;
  }): ReturnType<LlmProvider["complete"]> {
    this.prompts.push(`${input.system ?? ""}|${input.prompt}`);
    return Result.succeed({
      text: `answer(${input.prompt.slice(0, 20)})`,
      inputTokens: 10,
      outputTokens: 5,
      ...(this.toolCalls
        ? { toolCalls: [{ name: "payment.execute", arguments: { amount: 1 } }] }
        : {}),
    });
  }
}

const basePolicy: CapabilityPolicy = {
  actions: [{ actionType: "payment.execute" }, { actionType: "notify.send" }],
  llm: {
    models: ["fake-model"],
    maxCalls: 5,
    maxInputTokens: 10_000,
    maxOutputTokens: 1000,
    maxCostMicroUsd: 1_000_000,
  },
  maxEffects: 10,
};

const llmGrant = (maxCalls: number): CapabilityGrant => ({
  llm: {
    models: ["fake-model"],
    maxCalls,
    maxInputTokens: 1000,
    maxOutputTokens: 100,
    maxCostMicroUsd: 100_000,
  },
});

async function governedHarness(
  options: { policy?: CapabilityPolicy; limits?: ResourceLimits } = {},
) {
  let policy = options.policy ?? basePolicy;
  const llm = new FakeLlm();
  const h = await createWorkflowHarness({
    primitiveActionTypes: ["payment.execute", "notify.send", "equipment.order"],
    platform: {
      sandbox: new QuickJsSandbox(nodeQuickJsModule),
      governance: {
        capabilityPolicy: { policy: async () => Result.succeed(policy) },
        llmProvider: llm,
        llmPricing: {
          "fake-model": { inputMicroUsdPer1kTokens: 100, outputMicroUsdPer1kTokens: 200 },
        },
        ...(options.limits ? { resourceLimits: options.limits } : {}),
      },
    },
  });
  assert(h.platform.programAuthoring);
  return {
    ...h,
    llm,
    authoring: h.platform.programAuthoring,
    setPolicy(next: CapabilityPolicy) {
      policy = next;
    },
  };
}

async function publishProgram(
  h: Awaited<ReturnType<typeof governedHarness>>,
  programId: string,
  source: string,
  requestedCapabilities: NonNullable<
    Parameters<typeof h.authoring.draft>[0]["requestedCapabilities"]
  > = {},
): Promise<ProgramNodeReference> {
  const draft = await h.authoring.draft({
    organizationId: ORG,
    programId,
    source,
    inputSchema: { type: "any" },
    outputSchema: { type: "any" },
    requestedCapabilities,
    samples: [{ input: { dryRun: true } }],
  });
  if (Result.isFailure(draft) || !draft.value.ready)
    expect.fail(JSON.stringify(Result.isSuccess(draft) ? draft.value.tests : draft.error));
  const published = await h.authoring.publish({
    organizationId: ORG,
    draft: draft.value,
    samples: [{ input: { dryRun: true } }],
    publishedBy: "user:alice",
  });
  if (Result.isFailure(published)) expect.fail(published.error.message);
  return published.value.reference;
}

function programNode(
  nodeId: string,
  reference: ProgramNodeReference,
  capabilities?: CapabilityGrant,
): WorkflowNode {
  return {
    id: id(nodeId),
    type: "program",
    program: reference,
    input: obj({ dryRun: lit(false) }),
    ...(capabilities ? { capabilities } : {}),
  } as WorkflowNode;
}

const limitedAmount: Condition = {
  type: "comparison",
  left: { type: "field", path: "action.input.amount" },
  operator: "lte",
  right: { type: "literal", value: 10_000 },
};

describe("WE-161 agent delegation / capability broker / LLM gateway / resource governance", () => {
  it("identifies workflow / node agents as stable principals and enforces attribute-scoped delegation fail-closed", async () => {
    const h = await governedHarness();
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action(
              "pay",
              "payment.execute",
              obj({ amount: f("workflow.input.amount") }),
              lit("INV-1"),
              { restriction: limitedAmount },
            ),
            n.output(f("nodes.pay.output.input")),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:limited-pay"), name: "limited pay" },
      ),
      "limited.pay",
    );
    const ok = await h.submit("limited.pay", { amount: 5000 }, "R-1");
    const again = await h.submit("limited.pay", { amount: 6000 }, "R-2");
    await h.settle();
    expect(await h.status(ok.actionRequestId)).toBe("executed");
    const actors = [];
    for (const parent of [ok, again]) {
      const [child] = await h.children((await h.runOf(parent.actionRequestId)).state.runId);
      assert(child);
      const received = (await h.events(child.childActionRequestId)).find(
        (record) => record.event.type === "action.received",
      );
      assert(received?.event.type === "action.received");
      actors.push(received.event.actor);
      expect(received.event.delegationChain?.at(-1)?.scope?.condition).toEqual(limitedAmount);
    }
    // runを跨いでも同じNodeは同じagent principalとして監査される。
    expect(actors[0]).toEqual({ type: "agent", id: "workflow:wf:limited-pay/node:pay" });
    expect(actors[1]).toEqual(actors[0]);

    const tooLarge = await h.submit("limited.pay", { amount: 50_000 }, "R-3");
    await h.settle();
    expect(await h.result(tooLarge.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "authorization_denied",
    });
    // restrictionが参照するfield（currency）がAction inputに無い → 評価できずfail-closed。
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action(
              "pay",
              "payment.execute",
              obj({ amount: f("workflow.input.amount") }),
              lit("INV-2"),
              {
                restriction: {
                  type: "comparison",
                  left: { type: "field", path: "action.input.currency" },
                  operator: "eq",
                  right: { type: "literal", value: "JPY" },
                },
              },
            ),
            n.output(lit(null)),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:currency-pay"), name: "currency pay" },
      ),
      "currency.pay",
    );
    const missing = await h.submit("currency.pay", { amount: 1 }, "R-4");
    await h.settle();
    expect(await h.result(missing.actionRequestId)).toMatchObject({ status: "execution_failed" });
    const [missingChild] = await h.children((await h.runOf(missing.actionRequestId)).state.runId);
    assert(missingChild);
    const denied = (await h.events(missingChild.childActionRequestId)).find(
      (record) => record.event.type === "action.authorization_denied",
    );
    expect(denied?.event).toMatchObject({ code: "delegation_scope_invalid" });
    expect(h.executor.calls.map((call) => call.action.input)).not.toContainEqual({
      amount: 50_000,
    });
  });

  it("delegation expiry of the parent chain applies to the workflow's children (never widens)", async () => {
    const h = await governedHarness();
    await h.requireApproval("payment.execute");
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("pay", "payment.execute", obj({ amount: lit(1) })),
            n.output(lit(null)),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:expiring"), name: "expiring" },
      ),
      "expiring.pay",
    );
    const assistant = { type: "agent" as const, id: id<AgentId>("agent:assistant") };
    const expiresAt = new Date(Date.parse(h.clock.now()) + 60_000).toISOString();
    const submitted = await h.platform.service.submit({
      action: {
        type: id<ActionType>("expiring.pay"),
        resource: { type: id("employee"), id: id("E-1") },
        input: {},
      },
      trustedContext: {
        actor: assistant,
        authority: {
          principal: ALICE,
          delegation: {
            chain: [
              {
                delegator: ALICE,
                delegatee: assistant,
                grantId: id<DelegationGrantId>("grant:assistant"),
                scope: { actionTypes: [id<ActionType>("expiring.pay")], expiresAt },
              },
            ],
          },
        },
        origin: { type: "api" },
        organization: { id: ORG },
        now: h.clock.now(),
      },
    });
    assert(Result.isSuccess(submitted) && submitted.value.type === "accepted");
    await h.settle();
    const run = await h.runOf(submitted.value.actionRequestId);
    const [child] = await h.children(run.state.runId);
    assert(child);
    const plan = await h.loadPlan(child.childActionRequestId);
    expect(plan.evaluationSnapshot.authority.delegation?.chain[0]?.scope?.expiresAt).toBe(
      expiresAt,
    );

    // 親の委任が失効した後に承認されても、childの再認可で拒否される。
    h.clock.advance(3600);
    await h.approve(child.childActionRequestId);
    expect(await h.status(child.childActionRequestId)).toBe("authorization_revoked");
    expect(await h.status(submitted.value.actionRequestId)).toBe("execution_failed");
  });

  it("generated code cannot self-grant: publish-time review and runtime policy checks fail closed", async () => {
    const h = await governedHarness();
    const payer = await publishProgram(
      h,
      "program:payer",
      `function main(input, context) {
        if (input.dryRun) return ue.complete("dry");
        if (context.resume === null) return ue.action({}, "payment.execute", { type: "invoice", id: "I" }, { amount: 1 });
        return ue.complete("paid");
      }`,
      { actions: [{ actionType: "payment.execute" }] },
    );
    // Programが要求していないcapability（notify.send）をgrantしようとするとpublishできない。
    const overGrant = await h.platform.publishing.publish({
      organizationId: ORG,
      definition: definition(
        graph(
          [
            n.trigger(),
            programNode("p", payer, { actions: [{ actionType: id<ActionType>("notify.send") }] }),
            n.output(lit(null)),
          ],
          edges("start->p", "p->end"),
        ),
        { id: id("wf:over-grant"), name: "over grant" },
      ),
      publishedBy: ALICE,
      now: h.clock.now(),
    });
    expect(Result.isFailure(overGrant) && overGrant.error.code).toBe("capability_review_failed");
    expect(
      Result.isFailure(overGrant) && overGrant.error.issues?.map((issue) => issue.code),
    ).toContain("grant_not_requested");

    // 組織policyが許可しないcapabilityもgrantできない。
    h.setPolicy({ ...basePolicy, actions: [{ actionType: "notify.send" }] });
    const notPermitted = await h.platform.publishing.publish({
      organizationId: ORG,
      definition: definition(
        graph(
          [
            n.trigger(),
            programNode("p", payer, {
              actions: [{ actionType: id<ActionType>("payment.execute") }],
            }),
            n.output(lit(null)),
          ],
          edges("start->p", "p->end"),
        ),
        { id: id("wf:not-permitted"), name: "not permitted" },
      ),
      publishedBy: ALICE,
      now: h.clock.now(),
    });
    expect(
      Result.isFailure(notPermitted) && notPermitted.error.issues?.map((issue) => issue.code),
    ).toContain("grant_not_permitted");

    // publish後にpolicyが縮小されたら、実行時の作用も拒否される。
    h.setPolicy(basePolicy);
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            programNode("p", payer, {
              actions: [{ actionType: id<ActionType>("payment.execute") }],
            }),
            n.output(f("nodes.p.output")),
          ],
          edges("start->p", "p->end"),
        ),
        { id: id("wf:policy-shrink"), name: "policy shrink" },
      ),
      "policy.shrink",
    );
    h.setPolicy({ ...basePolicy, actions: [] });
    const shrunk = await h.submit("policy.shrink", {});
    await h.settle();
    expect(await h.result(shrunk.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "capability_denied",
    });
    expect(h.executor.calls).toHaveLength(0);
  });

  it("LLM Gateway keeps credentials host-side, minimizes prompts, enforces budgets durably, and returns tool requests as data", async () => {
    const h = await governedHarness();
    const asker = await publishProgram(
      h,
      "program:asker",
      `function main(input, context) {
        if (input.dryRun) return ue.complete("dry");
        const calls = context.resume ? context.resume.state.calls : 0;
        if (calls < input.times) return ue.llm({ calls: calls + 1 }, "fake-model", "use ${SECRET} to answer", 50);
        return ue.complete({ last: context.resume.effectResult.output });
      }`,
      {
        llm: {
          models: ["fake-model"],
          maxCalls: 5,
          maxInputTokens: 1000,
          maxOutputTokens: 100,
          maxCostMicroUsd: 100_000,
        },
      },
    );
    const workflow = (times: number, defId: string) =>
      definition(
        graph(
          [
            n.trigger(),
            {
              ...programNode("ask", asker, llmGrant(1)),
              input: obj({ dryRun: lit(false), times: lit(times) }),
            } as WorkflowNode,
            n.output(f("nodes.ask.output")),
          ],
          edges("start->ask", "ask->end"),
        ),
        { id: id(defId), name: defId },
      );
    await h.publish(workflow(1, "wf:ask-once"), "ask.once");
    const once = await h.submit("ask.once", {});
    await h.settle();
    const output = (await h.result(once.actionRequestId))?.result?.output as {
      last: { text: string; redactions: number };
    };
    expect(output.last.redactions).toBe(1);
    expect(h.llm.prompts[0]).not.toContain(SECRET);
    expect(h.llm.prompts[0]).toContain("[REDACTED]");
    const runRecord = await h.runOf(once.actionRequestId);
    expect(JSON.stringify(runRecord.state)).not.toContain(SECRET.slice(0, 12) + "x");
    const events = await h.platform.repositories.runs.listEvents({
      organizationId: ORG,
      runId: runRecord.state.runId,
    });
    assert(Result.isSuccess(events));
    expect(JSON.stringify(events.value)).not.toContain("REDACTED");

    await h.publish(workflow(2, "wf:ask-twice"), "ask.twice");
    const twice = await h.submit("ask.twice", {});
    await h.settle();

    expect(await h.result(twice.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "budget_exhausted",
    });
    const twiceRun = await h.runOf(twice.actionRequestId);
    const usage = await h.platform.repositories.llmUsage.usage({
      organizationId: ORG,
      runId: twiceRun.state.runId,
      nodeRunId: id("root:ask"),
    });
    expect(Result.isSuccess(usage) && usage.value.calls).toBe(1);
    const denied = h.db.db
      .prepare("SELECT status, code FROM workflow_llm_usage WHERE run_id = ? AND status = 'denied'")
      .all(String(twiceRun.state.runId));
    expect(denied).toEqual([{ status: "denied", code: "budget_exhausted" }]);

    h.llm.toolCalls = true;
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            {
              id: id("assistant"),
              type: "llm",
              model: "fake-model",
              prompt: lit("pay the invoice"),
              maxOutputTokens: 50,
              capabilities: llmGrant(1),
            } as WorkflowNode,
            n.output(f("nodes.assistant.output")),
          ],
          edges("start->assistant", "assistant->end"),
        ),
        { id: id("wf:tool"), name: "tool" },
      ),
      "llm.tool",
    );
    const tool = await h.submit("llm.tool", {});
    await h.settle();
    expect(await h.result(tool.actionRequestId)).toMatchObject({
      status: "executed",
      result: {
        output: {
          toolRequests: [{ actionType: "payment.execute", input: { amount: 1 }, granted: false }],
        },
      },
    });
    // tool要求はActionRequestを迂回して実行されない。
    expect(h.executor.calls).toHaveLength(0);
  });

  it("enforces tenant quotas durably and keeps a noisy tenant from exhausting system capacity", async () => {
    const limits: ResourceLimits = {
      tenant: { maxActiveRuns: 1, maxConcurrentSandboxes: 1, maxActionsPerRun: 1 },
      system: { maxActiveRuns: 10, maxConcurrentSandboxes: 2 },
      runLeaseSeconds: 3600,
      sandboxLeaseSeconds: 60,
    };
    const h = await governedHarness({ limits });
    await h.requireApproval("payment.execute");
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("pay", "payment.execute", obj({ amount: lit(1) })),
            n.output(lit(null)),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:hold"), name: "hold" },
      ),
      "hold.run",
    );
    const first = await h.submit("hold.run", {}, "Q-1");
    await h.settle();
    expect(await h.status(first.actionRequestId)).toBe("executing");
    // 同期実行の失敗としてsubmitはerrorを返し、結果はaction_resultsへdurableに記録される。
    const second = await h.platform.service.submit({
      action: {
        type: id<ActionType>("hold.run"),
        resource: { type: id("employee"), id: id("Q-2") },
        input: {},
      },
      trustedContext: {
        actor: ALICE,
        authority: { principal: ALICE },
        origin: { type: "api" },
        organization: { id: ORG },
        now: h.clock.now(),
      },
    });
    expect(Result.isFailure(second) && second.error.executionErrorCode).toBe("quota_exceeded");
    const secondResults = h.db.db
      .prepare("SELECT status, code FROM action_results WHERE code = 'quota_exceeded'")
      .all();
    expect(secondResults).toEqual([{ status: "execution_failed", code: "quota_exceeded" }]);

    const [child] = await h.children((await h.runOf(first.actionRequestId)).state.runId);
    assert(child);
    await h.approve(child.childActionRequestId);
    expect(await h.status(first.actionRequestId)).toBe("executed");
    // 終了したrunの枠は解放される。
    const third = await h.submit("hold.run", {}, "Q-3");
    await h.settle();
    expect(await h.status(third.actionRequestId)).toBe("executing");

    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("a", "notify.send", obj({})),
            n.action("b", "equipment.order", obj({})),
            n.output(lit(null)),
          ],
          edges("start->a", "a->b", "b->end"),
        ),
        { id: id("wf:two-actions"), name: "two actions" },
      ),
      "two.actions",
    );

    const governor = h.platform.governor;
    assert(governor);
    const otherOrg = id<OrganizationId>("org:quiet-tenant");
    const a1 = await governor.acquire({ organizationId: ORG });
    const a2 = await governor.acquire({ organizationId: ORG });
    const b1 = await governor.acquire({ organizationId: otherOrg });
    expect(Result.isSuccess(a1) && a1.value.type).toBe("admitted");
    expect(Result.isSuccess(a2) && a2.value.type).toBe("denied");
    expect(Result.isSuccess(b1) && b1.value.type).toBe("admitted");
  });

  it("limits the number of child Actions per run", async () => {
    const h = await governedHarness({
      limits: {
        tenant: { maxActiveRuns: 10, maxConcurrentSandboxes: 2, maxActionsPerRun: 1 },
        system: { maxActiveRuns: 10, maxConcurrentSandboxes: 4 },
        runLeaseSeconds: 3600,
        sandboxLeaseSeconds: 60,
      },
    });
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("a", "notify.send", obj({})),
            n.action("b", "equipment.order", obj({})),
            n.output(lit(null)),
          ],
          edges("start->a", "a->b", "b->end"),
        ),
        { id: id("wf:two-actions"), name: "two actions" },
      ),
      "two.actions",
    );
    const run = await h.submit("two.actions", {});
    await h.settle();
    expect(await h.result(run.actionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "quota_exceeded",
    });
    expect(h.executor.calls.map((call) => String(call.action.type))).toEqual(["notify.send"]);
  });

  it("rejects cross-tenant references to runs, programs, workflows, and composite actions", async () => {
    const h = await governedHarness();
    const program = await publishProgram(
      h,
      "program:tenant-a",
      `function main(input) { return ue.complete("a"); }`,
    );
    await h.publish(
      definition(
        graph(
          [n.trigger(), n.action("n1", "notify.send", obj({})), n.output(lit(null))],
          edges("start->n1", "n1->end"),
        ),
        {
          id: id("wf:tenant-a"),
          name: "tenant a",
        },
      ),
      "tenant.a",
    );
    const runA = await h.submit("tenant.a", {});
    await h.settle();
    const runIdA = (await h.runOf(runA.actionRequestId)).state.runId;

    const orgB = id<OrganizationId>("org:tenant-b");
    const tenantB = createWorkflowPlatform({
      db: h.db,
      organizationId: orgB,
      clock: h.clock,
      authorizer: new TableAuthorizer(),
      primitiveExecutors: { primitive: new RecordingExecutor() },
      workflowStarter: new RecordingApprovalStarter(),
      sandbox: new QuickJsSandbox(nodeQuickJsModule),
    });
    const foreignRun = await tenantB.repositories.runs.load({
      organizationId: orgB,
      runId: runIdA as WorkflowRunId,
    });
    expect(Result.isSuccess(foreignRun) && foreignRun.value).toBeNull();
    const foreignProgram = await tenantB.repositories.programs.load({
      organizationId: orgB,
      programId: "program:tenant-a",
      version: 1,
    });
    expect(Result.isSuccess(foreignProgram) && foreignProgram.value).toBeNull();
    const foreignVersion = await tenantB.repositories.versions.latest({
      organizationId: orgB,
      definitionId: id("wf:tenant-a"),
    });
    expect(Result.isSuccess(foreignVersion) && foreignVersion.value).toBeNull();
    const foreignTrace = await tenantB.trace(runA.actionRequestId);
    expect(foreignTrace?.run).toBeUndefined();

    // tenant BからはtenantAのComposite ActionもProgramも解決できない。
    const submitted = await tenantB.service.submit({
      action: {
        type: id<ActionType>("tenant.a"),
        resource: { type: id("employee"), id: id("E") },
        input: {},
      },
      trustedContext: {
        actor: ALICE,
        authority: { principal: ALICE },
        origin: { type: "api" },
        organization: { id: orgB },
        now: h.clock.now(),
      },
    });
    expect(Result.isFailure(submitted) && submitted.error.code).toBe("action_type_not_found");
    await tenantB.publishing.publish({
      organizationId: orgB,
      definition: definition(
        graph(
          [n.trigger(), programNode("p", program), n.output(f("nodes.p.output"))],
          edges("start->p", "p->end"),
        ),
        { id: id("wf:uses-foreign-program"), name: "foreign program" },
      ),
      publishedBy: ALICE,
      now: h.clock.now(),
      actionType: "foreign.program",
    });
    const foreign = await tenantB.service.submit({
      action: {
        type: id<ActionType>("foreign.program"),
        resource: { type: id("employee"), id: id("E") },
        input: {},
      },
      trustedContext: {
        actor: ALICE,
        authority: { principal: ALICE },
        origin: { type: "api" },
        organization: { id: orgB },
        now: h.clock.now(),
      },
    });
    assert(Result.isSuccess(foreign) && foreign.value.type === "accepted");
    for (let round = 0; round < 3; round += 1) {
      const due = await tenantB.repositories.runs.listDue({
        now: "2999-01-01T00:00:00.000Z",
        limit: 10,
      });
      if (Result.isSuccess(due)) for (const key of due.value) await tenantB.runtime.advance(key);
    }
    const foreignResult = await tenantB.repositories.results.load({
      organizationId: orgB,
      actionRequestId: foreign.value.actionRequestId,
    });
    expect(Result.isSuccess(foreignResult) && foreignResult.value).toMatchObject({
      status: "execution_failed",
      code: "program_not_found",
    });
  });
});
