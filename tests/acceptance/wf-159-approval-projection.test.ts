import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionType, Condition } from "@app/approval-core";
import { WorkflowApprovalProjector } from "@app/workflow-application";
import type { ApprovalProjection, ApprovalProjectionItem } from "@app/workflow-application";
import { PolicyApprovalRequirementProbe } from "@app/workflow-platform";
import type { WorkflowDefinition, WorkflowNode } from "@app/workflow-core";
import { definition, edges, f, graph, gt, id, lit, n, obj } from "@app/workflow-core/testing";

import { ALICE, ORG, createWorkflowHarness } from "../workflow/harness.ts";

const PRIMITIVES = ["payment.execute", "equipment.order", "notify.send", "github.add_member"];

const largePayment: Condition = {
  type: "comparison",
  left: { type: "field", path: "action.input.amount" },
  operator: "gt",
  right: { type: "literal", value: 10_000 },
};

const llmNode = {
  id: id("assistant"),
  type: "llm",
  model: "test-model",
  prompt: lit("summarize"),
  maxOutputTokens: 100,
  capabilities: {
    actions: [
      { actionType: id<ActionType>("notify.send") },
      { actionType: id<ActionType>("payment.execute") },
    ],
    llm: {
      models: ["test-model"],
      maxCalls: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      maxCostMicroUsd: 1000,
    },
  },
} as WorkflowNode;

function procurement(): WorkflowDefinition {
  return definition(
    graph(
      [
        n.trigger(),
        n.action("pay_fixed", "payment.execute", obj({ amount: lit(20_000) })),
        n.branch(
          "route",
          [{ key: "big", when: gt(f("workflow.input.amount"), lit(5000)) }],
          "small",
        ),
        n.action("pay_big", "payment.execute", obj({ amount: f("workflow.input.amount") })),
        n.action("order", "equipment.order", obj({ item: lit("laptop") })),
        n.join("merge"),
        n.forEach(
          "each",
          f("workflow.input.items"),
          graph(
            [n.action("pay_item", "payment.execute", obj({ amount: f("loop.item.amount") }))],
            [],
          ),
        ),
        llmNode,
        n.output(lit(null)),
      ],
      edges(
        "start->pay_fixed",
        "pay_fixed->route",
        ["route", "pay_big", "big"],
        ["route", "order", "small"],
        "pay_big->merge",
        "order->merge",
        "merge->each",
        "each->assistant",
        "assistant->end",
      ),
    ),
    {
      id: id("wf:procurement"),
      name: "procurement",
      inputFields: [
        { path: "workflow.input.amount", type: "number" },
        { path: "workflow.input.items", type: "array" },
      ],
    },
  );
}

function item(
  projection: ApprovalProjection,
  nodeId: string,
  actionType?: string,
): ApprovalProjectionItem {
  const found = projection.items.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      (actionType === undefined || candidate.actionType === actionType),
  );
  assert(found, `projection item ${nodeId} not found`);
  return found;
}

const requester = {
  actor: ALICE,
  authority: { principal: ALICE },
  origin: { type: "api" as const },
  organizationSettings: {},
  attributes: {},
};

describe("WE-159 Workflow Approval Projection / workflow-level approval", () => {
  it("classifies child approvals as statically resolved / conditional / potential / unresolved", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("payment.execute", largePayment);
    await h.requireApproval("procure.run");
    const published = await h.publish(procurement(), "procure.run");

    const projected = await h.platform.projector.project({
      organizationId: ORG,
      version: published.version,
      input: { amount: 50_000, items: [{ amount: 1 }] },
      requester,
      now: h.clock.now(),
      compositeActionType: id<ActionType>("procure.run"),
    });
    if (Result.isFailure(projected)) expect.fail(projected.error.message);
    const projection = projected.value;
    expect(projection.kind).toBe("projection");
    expect(projection.workflowLevel).toMatchObject({
      actionType: "procure.run",
      approval: { required: true, stepCount: 1 },
    });

    expect(item(projection, "pay_fixed")).toMatchObject({
      classification: "statically_resolved",
      reachability: "always",
      approval: { required: true },
    });
    expect(item(projection, "pay_big")).toMatchObject({
      classification: "conditional",
      approval: { required: true },
    });
    expect(item(projection, "order")).toMatchObject({
      classification: "conditional",
      approval: { required: false },
    });
    const perItem = item(projection, "pay_item");
    expect(perItem).toMatchObject({ classification: "unresolved", repeated: true, approval: null });
    expect(perItem.runtimeInputFields).toEqual(["amount"]);
    expect(perItem.unresolvedReason).toContain("field_missing");
    expect(item(projection, "assistant", "notify.send")).toMatchObject({
      source: "llm_capability",
      classification: "potential",
      approval: { required: false },
    });
    expect(item(projection, "assistant", "payment.execute")).toMatchObject({
      source: "llm_capability",
      classification: "unresolved",
    });
    // v1ではApproval Coverageを行わない（#166の境界）。
    expect(new Set(projection.items.map((candidate) => candidate.coverage.type))).toEqual(
      new Set(["not_covered"]),
    );
  });

  it("projects nested Composite Actions separately from the parent", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
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
        { id: id("wf:inner"), name: "inner" },
      ),
      "inner.pay",
    );
    const outer = await h.publish(
      definition(
        graph(
          [n.trigger(), n.action("inner", "inner.pay", obj({})), n.output(lit(null))],
          edges("start->inner", "inner->end"),
        ),
        { id: id("wf:outer"), name: "outer" },
      ),
      "outer.run",
    );
    const projected = await h.platform.projector.project({
      organizationId: ORG,
      version: outer.version,
      input: {},
      requester,
      now: h.clock.now(),
    });
    if (Result.isFailure(projected)) expect.fail(projected.error.message);
    const inner = item(projected.value, "inner");
    expect(inner).toMatchObject({ actionType: "inner.pay", approval: { required: false } });
    expect(inner.nested?.workflow.definitionId).toBe("wf:inner");
    expect(inner.nested?.workflowLevel).toMatchObject({
      actionType: "inner.pay",
      approval: { required: false },
    });
    expect(inner.nested?.items[0]).toMatchObject({
      path: ["inner", "pay"],
      actionType: "payment.execute",
      approval: { required: true },
    });
  });

  it("workflow-level approval and child approval are evaluated independently; the parent approval never skips the child approval", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("payment.execute");
    await h.requireApproval("expense.submit");
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("pay", "payment.execute", obj({ amount: f("workflow.input.amount") })),
            n.output(f("nodes.pay.output.input")),
          ],
          edges("start->pay", "pay->end"),
        ),
        {
          id: id("wf:expense"),
          name: "expense",
          inputFields: [{ path: "workflow.input.amount", type: "number" }],
        },
      ),
      "expense.submit",
    );
    const parent = await h.submit("expense.submit", { amount: 100 });
    // workflow-level approval（Composite Action自身のPolicy）。
    expect(parent.view.status).toBe("pending_approval");
    expect(parent.plan.flow.type).not.toBe("none");
    await h.approve(parent.actionRequestId);
    const run = await h.runOf(parent.actionRequestId);
    const [child] = await h.children(run.state.runId);
    assert(child);
    // 親が承認済みでも、child ActionRequestは独自のMaterialized Approval Planで承認を待つ。
    expect(await h.status(child.childActionRequestId)).toBe("pending_approval");
    expect((await h.loadPlan(child.childActionRequestId)).flow.type).not.toBe("none");
    expect(await h.status(parent.actionRequestId)).toBe("executing");

    const trace = await h.platform.trace(parent.actionRequestId);
    const actual = trace?.run?.nodeRuns[1]?.childActions[0];
    expect(actual).toMatchObject({
      actionType: "payment.execute",
      status: "pending_approval",
      approval: { required: true, source: "materialized_plan" },
    });

    await h.approve(child.childActionRequestId);
    expect(await h.status(parent.actionRequestId)).toBe("executed");
  });

  it("projection is not the enforcement source: runtime approval follows the policy materialized for the child", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    const published = await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("pay", "payment.execute", obj({ amount: lit(5) })),
            n.output(lit(null)),
          ],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:later-policy"), name: "later policy" },
      ),
      "later.run",
    );
    const projector = new WorkflowApprovalProjector({
      probe: new PolicyApprovalRequirementProbe({
        definitions: h.platform.actionDefinitionResolver,
        policyBindings: { resolve: async () => Result.succeed([]) },
        bindings: h.platform.repositories.bindings,
        versions: h.platform.repositories.versions,
      }),
      // #166のcoverageが「covered」と言っても、v1のenforcementはcoverageを参照しない。
      coverage: {
        evaluate: () => ({ type: "covered", parentApprovalEvidence: "parent-approved" }),
      },
    });
    const projected = await projector.project({
      organizationId: ORG,
      version: published.version,
      input: {},
      requester,
      now: h.clock.now(),
    });
    if (Result.isFailure(projected)) expect.fail(projected.error.message);
    expect(item(projected.value, "pay")).toMatchObject({
      approval: { required: false },
      coverage: { type: "covered" },
    });

    // projection後にPolicyが変わった → 実行時のchildは現在のPolicyで承認を要求される。
    await h.requireApproval("payment.execute");
    const parent = await h.submit("later.run", {});
    await h.settle();
    const [child] = await h.children((await h.runOf(parent.actionRequestId)).state.runId);
    assert(child);
    expect(await h.status(child.childActionRequestId)).toBe("pending_approval");
  });
});
