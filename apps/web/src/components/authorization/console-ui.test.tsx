import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  ApprovalFlowPresentation,
  ApprovalStepPresentation,
  ManagedRelationshipCatalog,
} from "@app/approval-core";

import { buildApprovalFlowGraph } from "../approval/approval-flow-graph.ts";
import { layoutApprovalFlowGraph } from "../approval/approval-flow-layout.ts";
import { ApprovalFlowTree } from "#components/approval/approval-flow-tree";
import { ApprovalStepDetail } from "#components/approval/approval-step-detail";
import { TooltipProvider } from "#components/ui/tooltip";
import type {
  ActionRequestView,
  AuthorizationExplainResult,
  AuthorizationModelView,
  RelationshipView,
} from "#lib/console-client";

import { explainRequestBody, ExplorerResult } from "./explorer.tsx";
import { ModelView } from "./model-view.tsx";
import {
  mutableCatalogEntries,
  relationshipActionRequest,
  RelationshipsTable,
  submissionSummary,
} from "./relationships.tsx";

function step(key: string, path: string, overrides: Partial<ApprovalStepPresentation> = {}) {
  return {
    type: "approval",
    path,
    materializedStepId: `step:${key}`,
    stepKey: key,
    purpose: "business_approval",
    target: {
      type: "relation",
      object: "team:finance",
      relation: "manager",
      sourceKind: "relation",
    },
    resolution: "dynamic",
    candidateCompletion: { type: "any", label: "any candidate" },
    source: {
      policyBindingId: "binding:ticket",
      policyKey: "policy:ticket",
      policyVersion: 3,
      matchedRuleKey: "default",
      flowPath: path,
    },
    ...overrides,
  } satisfies ApprovalStepPresentation;
}

const quorumFlow: ApprovalFlowPresentation = {
  requiresApproval: true,
  stepCount: 4,
  approvalPlanChecksum: "sha256:plan",
  interpreterSemanticsVersion: 1,
  root: {
    type: "serial",
    path: "root",
    label: "serial (2 in order)",
    children: [
      step("manager", "root.0"),
      {
        type: "quorum",
        group: "parallel",
        path: "root.1",
        required: 2,
        total: 3,
        label: "quorum 2/3",
        children: [
          step("finance", "root.1.0", {
            target: { type: "user", userId: "user:bob", sourceKind: "user" },
            resolution: "snapshot",
          }),
          step("security", "root.1.1"),
          step("legal", "root.1.2"),
        ],
      },
    ],
  },
};

const noneFlow: ApprovalFlowPresentation = {
  requiresApproval: false,
  stepCount: 0,
  approvalPlanChecksum: "sha256:none",
  interpreterSemanticsVersion: 1,
  root: { type: "none", path: "root", label: "Approval not required" },
};

function explain(overrides: Partial<AuthorizationExplainResult>): AuthorizationExplainResult {
  return {
    evaluatedAt: "2026-09-24T00:00:00.000Z",
    organizationId: "organization:staging",
    caller: { type: "user", id: "user:viewer" as never },
    simulatedPrincipal: { type: "user", id: "user:alice" as never },
    action: { type: "ticket.update", resource: { type: "ticket", id: "T-1" } },
    normalizedInput: { ticketId: "T-1" },
    authorization: {
      outcome: "allow",
      relation: "can_execute",
      logicalObject: "ticket:T-1",
      providerObject: "ticket:organization%3Astaging/T-1",
      consistency: "minimize_latency",
      authorizationModelId: "model-1",
    },
    applicablePolicies: [],
    approvalFlow: noneFlow,
    effectiveOutcome: "allowed_no_approval",
    proof: null,
    ...overrides,
  };
}

const render = (node: React.ReactNode) => renderToString(<TooltipProvider>{node}</TooltipProvider>);

describe("Simulation approval flow graph (AC-M9-002a)", () => {
  it("compiles serial order, quorum split/join with N/M and step nodes 1:1", () => {
    const graph = buildApprovalFlowGraph(quorumFlow);
    const steps = graph.nodes.filter((node) => node.kind === "step").map((node) => node.id);
    expect(steps).toEqual(["root.0", "root.1.0", "root.1.1", "root.1.2"]);
    const split = graph.nodes.find((node) => node.id === "root.1:split");
    const join = graph.nodes.find((node) => node.id === "root.1:join");
    expect(split?.label).toContain("quorum 2/3");
    expect(join?.label).toBe("2 of 3 branches complete");
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual(
      expect.arrayContaining([
        ["start", "root.0"],
        ["root.0", "root.1:split"],
        ["root.1:split", "root.1.0"],
        ["root.1.2", "root.1:join"],
        ["root.1:join", "end"],
      ]),
    );
    const layout = layoutApprovalFlowGraph(graph);
    expect(layout.nodes).toHaveLength(graph.nodes.length);
    const y = (id: string) => layout.nodes.find((node) => node.id === id)?.y ?? Number.NaN;
    expect(y("root.0")).toBeLessThan(y("root.1:split"));
    expect(y("root.1:split")).toBeLessThan(y("root.1.0"));
  });

  it("all / any groups keep completion semantics; none is an explicit node", () => {
    const all = buildApprovalFlowGraph({
      ...quorumFlow,
      root: {
        ...quorumFlow.root,
        type: "all",
        group: "parallel",
        required: 2,
        total: 2,
        label: "all 2/2",
        children: [step("a", "root.0"), step("b", "root.1")],
      } as never,
    });
    expect(all.nodes.find((node) => node.kind === "join")?.label).toBe(
      "all 2 branches must complete",
    );
    const any = buildApprovalFlowGraph({
      ...quorumFlow,
      root: {
        type: "any",
        group: "parallel",
        path: "root",
        required: 1,
        total: 2,
        label: "any 1/2",
        children: [step("a", "root.0"), step("b", "root.1")],
      },
    });
    expect(any.nodes.find((node) => node.kind === "join")?.label).toBe(
      "any 1 of 2 branches completes",
    );
    const none = buildApprovalFlowGraph(noneFlow);
    expect(none.nodes.map((node) => node.kind)).toEqual(["start", "none", "end"]);
  });

  it("the accessible tree carries the same steps, order and completion text as the graph", () => {
    const html = render(<ApprovalFlowTree root={quorumFlow.root} onSelect={() => undefined} />);
    for (const key of ["manager", "finance", "security", "legal"]) expect(html).toContain(key);
    expect(html).toContain("Serial — in order (2)");
    expect(html).toContain("quorum 2/3 — 2 of 3 branches complete");
    expect(html).toContain("<ol");
    expect(html.match(/data-node-type="approval"/g)).toHaveLength(4);
  });

  it("step detail shows target, resolution and source policy metadata", () => {
    const html = render(
      <ApprovalStepDetail step={step("finance", "root.1.0", { resolution: "snapshot" })} />,
    );
    expect(html).toContain("manager of team:finance");
    expect(html).toContain("snapshot");
    expect(html).toContain("policy:ticket");
    expect(html).toContain("default");
    expect(html).toContain("root.1.0");
  });
});

describe("Explorer result presentation (AC-M9-002)", () => {
  it("deny / no approval / approval required / evaluation error are semantically distinct", () => {
    const outcomes = {
      deny: explain({
        effectiveOutcome: "deny",
        authorization: { ...explain({}).authorization, outcome: "deny", code: "fga_check_denied" },
        approvalFlow: null,
      }),
      allowed_no_approval: explain({}),
      allowed_requires_approval: explain({
        effectiveOutcome: "allowed_requires_approval",
        approvalFlow: quorumFlow,
      }),
      evaluation_error: explain({
        effectiveOutcome: "evaluation_error",
        authorization: { ...explain({}).authorization, outcome: "not_evaluated" },
        approvalFlow: null,
        normalizedInput: null,
        error: {
          code: "action_input_validation_failed",
          message: "ticketIdが必要です",
          issues: [{ message: "ticketIdが必要です", path: "ticketId" }],
        },
      }),
    } as const;
    for (const [outcome, result] of Object.entries(outcomes)) {
      const html = render(<ExplorerResult result={result} />);
      expect(html).toContain(`data-status="${outcome}"`);
    }
    const error = render(<ExplorerResult result={outcomes.evaluation_error} />);
    expect(error).toContain("this is not “no approval required”");
    expect(error).not.toContain("Approval not required");
    expect(error).toContain("ticketId");
    const none = render(<ExplorerResult result={outcomes.allowed_no_approval} />);
    expect(none).toContain("Approval not required");
    expect(none).toContain("user:viewer");
    expect(none).toContain("user:alice");
  });

  it("sends complete action.input (omitted when empty; JSON syntax errors stay client-side)", () => {
    const base = {
      principalType: "user" as const,
      principalId: "user:alice",
      actionType: "ticket.update",
      resourceType: "ticket",
      resourceId: "T-1",
      overrides: "",
    };
    expect(explainRequestBody({ ...base, input: "" })).toEqual({
      body: {
        principal: { type: "user", id: "user:alice" },
        action: { type: "ticket.update", resource: { type: "ticket", id: "T-1" } },
      },
    });
    expect(explainRequestBody({ ...base, input: '{"ticketId":"T-1"}' })).toMatchObject({
      body: { action: { input: { ticketId: "T-1" } } },
    });
    expect(explainRequestBody({ ...base, input: "{" })).toEqual({
      error: "action.input is not valid JSON",
    });
  });
});

describe("Relationships presentation (AC-M9-004 / AC-M9-005)", () => {
  const catalog: ManagedRelationshipCatalog = [
    { objectType: "ticket", relation: "can_execute", subjectTypes: ["user"], description: "" },
    {
      objectType: "authorization_admin",
      relation: "editor",
      subjectTypes: ["user"],
      description: "",
    },
  ];

  it("never offers authorization_admin and builds one governed ActionRequest per tuple", () => {
    expect(mutableCatalogEntries(catalog).map((entry) => entry.objectType)).toEqual(["ticket"]);
    expect(
      relationshipActionRequest({
        operation: "delete",
        catalogKey: "ticket#can_execute",
        userId: " user:alice ",
        objectId: "T-1",
      }),
    ).toEqual({
      action: {
        type: "authorization.relationship.update",
        resource: { type: "authorization_admin", id: "root" },
        input: {
          operation: "delete",
          tuple: { user: "user:alice", relation: "can_execute", object: "ticket:T-1" },
        },
      },
    });
  });

  function view(
    status: ActionRequestView["status"],
    relationshipStatus?: string,
  ): ActionRequestView {
    return {
      id: "action:1",
      organizationId: "organization:staging",
      actor: { type: "user", id: "user:editor" as never },
      authorityPrincipal: { type: "user", id: "user:editor" as never },
      action: {} as never,
      origin: "ui",
      status,
      approval: { required: status === "pending_approval" },
      ...(relationshipStatus
        ? {
            result: {
              status: "executed",
              output: { relationship: { status: relationshipStatus } },
            },
          }
        : {}),
      checksums: {} as never,
      createdAt: "",
      updatedAt: "",
    };
  }

  it("pending / indeterminate / superseded are never presented as changed", () => {
    expect(submissionSummary(view("pending_approval")).message).toContain("has not been changed");
    expect(submissionSummary(view("executed", "indeterminate")).message).toContain("not confirmed");
    expect(submissionSummary(view("executed", "superseded")).message).toContain("newer change");
    expect(submissionSummary(view("executed", "confirmed")).message).toContain("confirmed");
    expect(submissionSummary(view("authorization_revoked")).message).toContain("Not applied");
  });

  function row(overrides: Partial<RelationshipView>): RelationshipView {
    return {
      tupleKey: "tuple:1",
      subject: "user:alice",
      relation: "can_execute",
      object: "ticket:T-1",
      objectType: "ticket",
      providerObject: "ticket:organization%3Astaging/T-1",
      managed: true,
      desiredState: "present",
      revision: 2,
      confirmedRevision: 1,
      confirmedState: "present",
      syncStatus: "indeterminate",
      lastErrorCode: "fga_http_503",
      sourceActionRequestId: "action:2",
      latestMutationKey: "m-2",
      createdAt: "",
      updatedAt: "2026-09-24T00:00:00.000Z",
      ...overrides,
    };
  }

  it("delete controls only for editors on managed relationships; statuses are explicit", () => {
    const viewerHtml = render(
      <RelationshipsTable
        items={[row({})]}
        canEdit={false}
        onInspect={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(viewerHtml).not.toContain("Delete user:alice");
    expect(viewerHtml).toContain("Unknown · reconciling");
    expect(viewerHtml).not.toContain('data-status="confirmed"');

    const editorHtml = render(
      <RelationshipsTable
        items={[row({}), row({ tupleKey: "tuple:2", managed: false, subject: "user:bob" })]}
        canEdit
        onInspect={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(editorHtml).toContain("Delete user:alice can_execute ticket:T-1");
    expect(editorHtml).not.toContain("Delete user:bob");
  });
});

describe("Model view (AC-M9-008)", () => {
  it("is read-only: no save / publish / delete / membership controls", () => {
    const model: AuthorizationModelView = {
      activeModelId: "model-1",
      provider: { apiHost: "api.us1.fga.dev", storeId: "store-1" },
      schemaVersion: "1.1",
      typeDefinitions: [
        { type: "authorization_admin", relations: ["editor", "viewer"], definition: {} },
        { type: "ticket", relations: ["can_approve", "can_execute"], definition: {} },
      ],
      conditions: [],
      providerChecksum: "sha256:a",
      source: {
        path: "packages/approval-fga/openfga/model.fga",
        testsPath: "packages/approval-fga/openfga/store.fga.yaml",
        checksum: "sha256:a",
        matchesProvider: true,
        revision: null,
      },
      readOnly: true,
    };
    const html = render(<ModelView model={model} />);
    expect(html).toContain("read-only");
    expect(html).toContain("packages/approval-fga/openfga/model.fga");
    expect(html).toContain('data-status="in-sync"');
    for (const forbidden of ["Save", "Publish", "Delete model", "Add member", "credential"]) {
      expect(html).not.toContain(forbidden);
    }
    const buttons = html.match(/<button[^>]*aria-label="([^"]*)"/g) ?? [];
    expect(buttons.every((button) => button.includes("Copy"))).toBe(true);
  });
});
