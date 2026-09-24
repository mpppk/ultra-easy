import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionDefinition } from "./action-definition.ts";
import { approvalFlowPresentation } from "./approval-flow-presentation.ts";
import {
  always,
  approve,
  definePolicy,
  literal,
  none,
  object,
  parallelAll,
  parallelAny,
  parallelQuorum,
  relation,
  rule,
  serial,
  user,
} from "./builder.ts";
import type {
  ActionDefinitionKey,
  ActionRequestId,
  ApprovalPolicyBindingId,
  ExecutorKey,
  OrganizationId,
  SchemaKey,
} from "./domain/brand.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import type { FlowDefinition } from "./domain/flow.ts";
import { materializeApprovalPlan } from "./materialization.ts";
import { createTicketActionRequest } from "./testing/fixtures.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("organization:tenant-a");

function context(): PolicyEvaluationContext {
  return {
    ...createTicketActionRequest(),
    organization: { id: organizationId },
    now: "2026-09-24T00:00:00.000Z",
  };
}

function definition(ctx: PolicyEvaluationContext): ActionDefinition {
  return {
    key: branded<ActionDefinitionKey>("ticket-update"),
    version: 1,
    actionType: ctx.action.type,
    inputSchema: { key: branded<SchemaKey>("ticket-update"), version: 1 },
    executorKey: branded<ExecutorKey>("staging"),
  };
}

const manager = approve({
  key: "manager",
  purpose: "business_approval",
  approver: relation({ object: object("team", literal("finance")), relation: "manager" }),
});
const finance = approve({
  key: "finance",
  approver: user(literal("user:bob")),
  resolution: "snapshot",
  candidateCompletion: "all",
});
const security = approve({
  key: "security",
  purpose: "security_approval",
  approver: user(literal("user:carol")),
});

async function plan(flow: FlowDefinition) {
  const ctx = context();
  const materialized = await materializeApprovalPlan({
    actionRequestId: branded<ActionRequestId>("action:explain-1"),
    context: ctx,
    actionDefinition: definition(ctx),
    policyBindings: [
      {
        binding: {
          id: branded<ApprovalPolicyBindingId>("binding:ticket"),
          organizationId,
          policyKey: branded("policy:ticket"),
          selector: { actionTypes: [ctx.action.type] },
          enabled: true,
        },
        policyVersion: 3,
        policy: definePolicy({
          key: "policy:ticket",
          name: "Ticket",
          rules: [rule("default", { when: always(), flow })],
        }),
      },
    ],
  });
  assert(materialized.type === "materialized", JSON.stringify(materialized));
  return materialized.plan;
}

describe("approvalFlowPresentation (AC-M9-002a)", () => {
  it("none flow is explicit 'Approval not required', never an empty graph", async () => {
    const presented = approvalFlowPresentation(await plan(none()));
    expect(presented.requiresApproval).toBe(false);
    expect(presented.stepCount).toBe(0);
    expect(presented.root).toEqual({ type: "none", path: "root", label: "Approval not required" });
  });

  it("serial keeps child order and nests a quorum group with threshold and children", async () => {
    const source = await plan(serial(manager, parallelQuorum(1, finance, security)));
    const presented = approvalFlowPresentation(source);
    expect(presented.requiresApproval).toBe(true);
    expect(presented.stepCount).toBe(3);
    expect(presented.approvalPlanChecksum).toBe(String(source.approvalPlanChecksum));

    const root = presented.root;
    assert(root.type === "serial");
    expect(root.children.map((child) => child.path)).toEqual(["root.0", "root.1"]);
    const [first, second] = root.children;
    assert(first?.type === "approval");
    expect(first).toMatchObject({
      stepKey: "manager",
      purpose: "business_approval",
      target: { type: "relation", object: "team:finance", relation: "manager" },
      resolution: "dynamic",
      candidateCompletion: { type: "any" },
      source: {
        policyBindingId: "binding:ticket",
        policyKey: "policy:ticket",
        policyVersion: 3,
        matchedRuleKey: "default",
      },
    });
    assert(second?.type === "quorum");
    expect(second).toMatchObject({ group: "parallel", required: 1, total: 2, label: "quorum 1/2" });
    expect(second.children.map((child) => child.type === "approval" && child.stepKey)).toEqual([
      "finance",
      "security",
    ]);
    const financeStep = second.children[0];
    assert(financeStep?.type === "approval");
    expect(financeStep).toMatchObject({
      target: { type: "user", userId: "user:bob" },
      resolution: "snapshot",
      candidateCompletion: { type: "all" },
    });
  });

  it("parallel all / any preserve completion semantics", async () => {
    const all = approvalFlowPresentation(await plan(parallelAll(manager, finance, security))).root;
    assert(all.type === "all");
    expect(all).toMatchObject({ required: 3, total: 3, label: "all 3/3" });

    const any = approvalFlowPresentation(await plan(parallelAny(manager, finance))).root;
    assert(any.type === "any");
    expect(any).toMatchObject({ required: 1, total: 2, label: "any 1/2" });
  });

  it("every approval node maps 1:1 to a MaterializedStepId in the plan (no re-derivation)", async () => {
    const source = await plan(serial(manager, parallelAny(finance, security)));
    const presented = approvalFlowPresentation(source);
    const ids: string[] = [];
    const visit = (node: typeof presented.root): void => {
      if (node.type === "approval") ids.push(node.materializedStepId);
      else if (node.type !== "none") node.children.forEach(visit);
    };
    visit(presented.root);
    const planIds: string[] = [];
    const visitPlan = (flow: typeof source.flow): void => {
      if (flow.type === "approval") planIds.push(String(flow.materializedStepId));
      else if (flow.type !== "none") flow.children.forEach(visitPlan);
    };
    visitPlan(source.flow);
    expect(ids).toEqual(planIds);
    expect(JSON.parse(JSON.stringify(presented))).toEqual(presented);
  });
});
