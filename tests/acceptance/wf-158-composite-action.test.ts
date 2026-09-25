import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { Sha256Digest } from "@app/approval-core";
import type { WorkflowDefinition } from "@app/workflow-core";
import { definition, edges, f, graph, id, lit, n, obj } from "@app/workflow-core/testing";

import { ALICE, createWorkflowHarness } from "../workflow/harness.ts";

const PRIMITIVES = [
  "google.create_account",
  "github.add_member",
  "equipment.order",
  "payment.execute",
];

function onboarding(extraNode = false): WorkflowDefinition {
  return definition(
    graph(
      [
        n.trigger(),
        n.action(
          "account",
          "google.create_account",
          obj({ email: f("workflow.input.email") }),
          f("workflow.input.employeeId"),
        ),
        n.action(
          "github",
          "github.add_member",
          obj({ login: f("workflow.input.github") }),
          f("workflow.input.employeeId"),
        ),
        n.join("both"),
        ...(extraNode ? [n.transform("marker", lit("v2"))] : []),
        n.output(
          obj({
            email: f("nodes.account.output.input.email"),
            login: f("nodes.github.output.input.login"),
            ...(extraNode ? { version: f("nodes.marker.output") } : {}),
          }),
        ),
      ],
      edges(
        "start->account",
        "start->github",
        "account->both",
        "github->both",
        ...(extraNode ? ["both->marker", "marker->end"] : ["both->end"]),
      ),
    ),
    {
      id: id("wf:employee-onboard"),
      name: "Employee onboarding",
      inputFields: [
        { path: "workflow.input.employeeId", type: "string" },
        { path: "workflow.input.email", type: "string" },
        { path: "workflow.input.github", type: "string" },
      ],
    },
  );
}

const input = { employeeId: "EMP-1", email: "bob@example.com", github: "bob" };

describe("WE-158 Composite Action / WorkflowActionExecutor / nested workflow", () => {
  it("publishes a Workflow as a versioned Composite Action and completes the parent only after the WorkflowRun ends", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    const published = await h.publish(onboarding(), "employee.onboard");
    expect(published.composite?.definition).toMatchObject({
      actionType: "employee.onboard",
      executorKey: "workflow",
      version: 1,
      inputSchema: { key: "workflow-input:wf:employee-onboard", version: 1 },
    });

    const submitted = await h.submit("employee.onboard", input);
    // WorkflowRun開始（accepted）はparent Actionの完了ではない。
    expect(submitted.view.status).toBe("executing");
    expect(await h.result(submitted.actionRequestId)).toBeNull();
    const parentEvents = await h.events(submitted.actionRequestId);
    expect(parentEvents.map((record) => record.event.type)).toContain("action.execution_accepted");

    await h.settle();
    expect(await h.status(submitted.actionRequestId)).toBe("executed");
    expect(await h.result(submitted.actionRequestId)).toMatchObject({
      status: "executed",
      result: { output: { email: "bob@example.com", login: "bob" } },
    });
    const run = await h.runOf(submitted.actionRequestId);
    expect(run.state.status).toBe("succeeded");
    expect(run.completionDelivered).toBe(true);
    expect(run.invocation.parentAction?.executionRef).toBe(String(run.state.runId));
  });

  it("issues every child side effect as a normal ActionRequest (authorization + re-authorization, delegated to a node agent)", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.publish(onboarding(), "employee.onboard");
    const submitted = await h.submit("employee.onboard", input);
    await h.settle();
    const run = await h.runOf(submitted.actionRequestId);
    const children = await h.children(run.state.runId);
    expect(children.map((child) => String(child.actionType)).sort()).toEqual([
      "github.add_member",
      "google.create_account",
    ]);
    for (const child of children) {
      const plan = await h.loadPlan(child.childActionRequestId);
      const snapshot = plan.evaluationSnapshot;
      expect(snapshot.actor).toEqual({
        type: "agent",
        id: `workflow:wf:employee-onboard/node:${String(child.nodeRunId).split(":")[1]}`,
      });
      expect(snapshot.authority.principal).toEqual(ALICE);
      expect(
        snapshot.authority.delegation?.chain.map((hop) => [hop.delegator.id, hop.delegatee.id]),
      ).toEqual([
        [ALICE.id, "workflow:wf:employee-onboard"],
        ["workflow:wf:employee-onboard", snapshot.actor.id],
      ]);
      expect(snapshot.origin).toMatchObject({
        type: "system",
        agentRunId: String(run.state.runId),
      });
      const types = (await h.events(child.childActionRequestId)).map((record) => record.event.type);
      // Authorization → Plan → Re-Authorization → Executorの順で通常pipelineを通る。
      expect(types).toEqual(
        expect.arrayContaining([
          "action.received",
          "action.authorized",
          "action.reauthorized",
          "action.completed",
        ]),
      );
    }
    // primitive executorが呼ばれたのはchild ActionRequestだけ（Workflow RuntimeはExecutorを直接呼ばない）。
    expect(h.executor.calls.map((call) => String(call.actionRequestId)).sort()).toEqual(
      children.map((child) => String(child.childActionRequestId)).sort(),
    );
  });

  it("runs nested workflows as Action recursion and limits recursion / runaway nesting", async () => {
    const h = await createWorkflowHarness({
      primitiveActionTypes: PRIMITIVES,
      platform: { maxDepth: 1 },
    });
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("order", "equipment.order", obj({ item: lit("laptop") })),
            n.output(f("nodes.order.output.input")),
          ],
          edges("start->order", "order->end"),
        ),
        { id: id("wf:orientation"), name: "orientation" },
      ),
      "orientation.prepare",
    );
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("orient", "orientation.prepare", obj({})),
            n.output(obj({ orientation: f("nodes.orient.output") })),
          ],
          edges("start->orient", "orient->end"),
        ),
        { id: id("wf:onboard-nested"), name: "nested onboarding" },
      ),
      "employee.onboard_nested",
    );
    const nested = await h.submit("employee.onboard_nested", {});
    await h.settle();
    expect(await h.status(nested.actionRequestId)).toBe("executed");
    expect(await h.result(nested.actionRequestId)).toMatchObject({
      result: { output: { orientation: { item: "laptop" } } },
    });
    const trace = await h.platform.trace(nested.actionRequestId);
    const orientNode = trace?.run?.nodeRuns.find((node) => node.nodeId === "orient");
    expect(orientNode?.childActions[0]).toMatchObject({
      actionType: "orientation.prepare",
      status: "executed",
      run: { definitionId: "wf:orientation", depth: 1, status: "succeeded" },
    });
    expect(orientNode?.childActions[0]?.run?.nodeRuns[1]?.childActions[0]).toMatchObject({
      actionType: "equipment.order",
      status: "executed",
    });

    // 自分自身を呼ぶWorkflowはrecursionとして拒否され、v1 fail-fastで親まで失敗する。
    await h.publish(
      definition(
        graph(
          [n.trigger(), n.action("again", "loop.self", obj({})), n.output(lit(null))],
          edges("start->again", "again->end"),
        ),
        { id: id("wf:self"), name: "self" },
      ),
      "loop.self",
    );
    const recursive = await h.submit("loop.self", {});
    await h.settle();
    expect(await h.status(recursive.actionRequestId)).toBe("execution_failed");
    const recursiveRun = await h.runOf(recursive.actionRequestId);
    const [selfChild] = await h.children(recursiveRun.state.runId);
    assert(selfChild);
    expect(await h.result(selfChild.childActionRequestId)).toMatchObject({
      status: "execution_failed",
      code: "workflow_recursion_detected",
    });

    // depth上限（maxDepth=1）を超えるnestは拒否される。
    await h.publish(
      definition(
        graph(
          [
            n.trigger(),
            n.action("deeper", "employee.onboard_nested", obj({})),
            n.output(lit(null)),
          ],
          edges("start->deeper", "deeper->end"),
        ),
        { id: id("wf:too-deep"), name: "too deep" },
      ),
      "too.deep",
    );
    const deep = await h.submit("too.deep", {});
    await h.settle();
    expect(await h.status(deep.actionRequestId)).toBe("execution_failed");
    expect(await h.result(deep.actionRequestId)).toMatchObject({ code: "execution_failed" });
  });

  it("pins the WorkflowVersion at prepare time: approval pending during a new publish still executes the old version", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("employee.onboard");
    const v1 = await h.publish(onboarding(), "employee.onboard");
    const pending = await h.submit("employee.onboard", input, "EMP-1");
    expect(pending.view.status).toBe("pending_approval");
    expect(pending.plan.action.definition).toMatchObject({ version: 1 });

    const v2 = await h.publish(onboarding(true), "employee.onboard");
    expect(v2.version.version).toBe(2);
    expect(v2.composite?.definition.version).toBe(2);

    await h.approve(pending.actionRequestId);
    const oldRun = await h.runOf(pending.actionRequestId);
    expect(oldRun.state.version).toBe(1);
    expect(String(oldRun.state.checksum)).toBe(String(v1.version.checksum));
    expect(await h.result(pending.actionRequestId)).toMatchObject({
      status: "executed",
      result: { output: { email: "bob@example.com", login: "bob" } },
    });

    const fresh = await h.submit("employee.onboard", input, "EMP-2");
    await h.approve(fresh.actionRequestId);
    const newRun = await h.runOf(fresh.actionRequestId);
    expect(newRun.state.version).toBe(2);
    expect(await h.result(fresh.actionRequestId)).toMatchObject({
      result: { output: { version: "v2" } },
    });
  });

  it("ActionDefinition version -> WorkflowVersion bindings are immutable", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    const published = await h.publish(onboarding(), "employee.onboard");
    const binding = published.composite?.binding;
    assert(binding);
    const substituted = await h.platform.repositories.bindings.save({
      ...binding,
      workflowVersion: 2,
      workflowChecksum: id<Sha256Digest>("sha256:attacker"),
    });
    expect(Result.isFailure(substituted) && substituted.error.code).toBe(
      "workflow_action_binding_conflict",
    );
    expect(() => h.db.db.exec("UPDATE workflow_action_bindings SET workflow_version = 99")).toThrow(
      /immutable/,
    );
    expect(() => h.db.db.exec("DELETE FROM workflow_action_bindings")).toThrow(/immutable/);
  });

  it("child approval keeps the node waiting; approval resumes; rejection and authorization failures propagate fail-fast", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("payment.execute");
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
        { id: id("wf:pay"), name: "pay" },
      ),
      "expense.reimburse",
    );
    const parent = await h.submit("expense.reimburse", { amount: 5000 });
    await h.settle();
    const run = await h.runOf(parent.actionRequestId);
    expect(run.state.nodeRuns["root:pay"]).toMatchObject({
      status: "waiting",
      waitingReason: "waiting_approval",
    });
    expect(await h.status(parent.actionRequestId)).toBe("executing");
    const [child] = await h.children(run.state.runId);
    assert(child);
    expect(await h.status(child.childActionRequestId)).toBe("pending_approval");

    await h.approve(child.childActionRequestId);
    expect(await h.status(parent.actionRequestId)).toBe("executed");
    expect(await h.result(parent.actionRequestId)).toMatchObject({
      result: { output: { amount: 5000 } },
    });

    const rejected = await h.submit("expense.reimburse", { amount: 7000 }, "EXP-2");
    await h.settle();
    const rejectedRun = await h.runOf(rejected.actionRequestId);
    const [rejectedChild] = await h.children(rejectedRun.state.runId);
    assert(rejectedChild);
    await h.reject(rejectedChild.childActionRequestId);
    expect(await h.status(rejected.actionRequestId)).toBe("execution_failed");
    expect(await h.result(rejected.actionRequestId)).toMatchObject({ code: "rejected" });

    h.authorizer.denied.add("payment.execute");
    const denied = await h.submit("expense.reimburse", { amount: 1 }, "EXP-3");
    await h.settle();
    expect(await h.status(denied.actionRequestId)).toBe("execution_failed");
    expect(await h.result(denied.actionRequestId)).toMatchObject({ code: "authorization_denied" });
  });

  it("cancellation of a parent run propagates to composite children", async () => {
    const h = await createWorkflowHarness({ primitiveActionTypes: PRIMITIVES });
    await h.requireApproval("payment.execute");
    await h.publish(
      definition(
        graph(
          [n.trigger(), n.action("pay", "payment.execute", obj({})), n.output(lit(null))],
          edges("start->pay", "pay->end"),
        ),
        { id: id("wf:inner-pay"), name: "inner" },
      ),
      "inner.pay",
    );
    await h.publish(
      definition(
        graph(
          [n.trigger(), n.action("inner", "inner.pay", obj({})), n.output(lit(null))],
          edges("start->inner", "inner->end"),
        ),
        { id: id("wf:outer"), name: "outer" },
      ),
      "outer.run",
    );
    const outer = await h.submit("outer.run", {});
    await h.settle();
    const outerRun = await h.runOf(outer.actionRequestId);
    const [innerChild] = await h.children(outerRun.state.runId);
    assert(innerChild);
    const innerRun = await h.runOf(innerChild.childActionRequestId);
    expect(innerRun.state.status).toBe("waiting");

    const cancelled = await h.platform.runtime.cancel({
      organizationId: outerRun.state.organizationId,
      runId: outerRun.state.runId,
      reason: "operator cancelled",
    });
    expect(Result.isSuccess(cancelled) && cancelled.value.status).toBe("cancelled");
    await h.settle();
    expect((await h.runById(innerRun.state.runId)).state.status).toBe("cancelled");
    expect(await h.status(innerChild.childActionRequestId)).toBe("execution_failed");
    expect(await h.result(innerChild.childActionRequestId)).toMatchObject({
      code: "workflow_cancelled",
    });
    expect(await h.status(outer.actionRequestId)).toBe("execution_failed");
    expect(await h.result(outer.actionRequestId)).toMatchObject({ code: "workflow_cancelled" });
  });
});
