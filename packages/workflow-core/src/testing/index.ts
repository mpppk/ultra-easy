import type { ActionType, OrganizationId, PrincipalRef, UserId } from "@app/approval-core";
import type { Condition, JsonValue, ValueExpression, ValueTemplate } from "@app/expression-core";

import type {
  ActionNode,
  BranchNode,
  ForEachNode,
  JoinNode,
  OutputNode,
  TransformNode,
  TriggerNode,
  WhileNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "../definition.ts";
import type { NodeId, WorkflowDefinitionId, WorkflowRunId } from "../ids.ts";
import type { WorkflowRunContext } from "../state.ts";

/** test専用: brandへ変換する。 */
export function id<T extends string>(value: string): T {
  return value as T;
}

export const TEST_ORGANIZATION_ID = id<OrganizationId>("org:workflow-test");
export const TEST_ACTOR: PrincipalRef = { type: "user", id: id<UserId>("user:alice") };
export const TEST_CONTEXT: WorkflowRunContext = {
  actor: TEST_ACTOR,
  organizationSettings: { approvalLimit: 10_000 },
  attributes: {},
};

export const f = (path: string): ValueExpression => ({ type: "field", path });
export const lit = (value: JsonValue): ValueExpression => ({ type: "literal", value });
export const obj = (fields: Record<string, ValueTemplate>): ValueTemplate => ({
  type: "object",
  fields,
});
export const eq = (left: ValueExpression, right: ValueExpression): Condition => ({
  type: "comparison",
  left,
  operator: "eq",
  right,
});
export const gt = (left: ValueExpression, right: ValueExpression): Condition => ({
  type: "comparison",
  left,
  operator: "gt",
  right,
});
export const lt = (left: ValueExpression, right: ValueExpression): Condition => ({
  type: "comparison",
  left,
  operator: "lt",
  right,
});

export const n = {
  trigger: (nodeId = "start"): TriggerNode => ({ id: id<NodeId>(nodeId), type: "trigger" }),
  action: (
    nodeId: string,
    actionType: string,
    input: ValueTemplate = obj({}),
    resourceId: ValueExpression = lit(`resource:${nodeId}`),
    extra: Partial<ActionNode> = {},
  ): ActionNode => ({
    id: id<NodeId>(nodeId),
    type: "action",
    actionType: id<ActionType>(actionType),
    resource: { type: "test_resource", id: resourceId },
    input,
    ...extra,
  }),
  branch: (nodeId: string, cases: BranchNode["cases"], defaultKey?: string): BranchNode => ({
    id: id<NodeId>(nodeId),
    type: "branch",
    cases,
    ...(defaultKey !== undefined ? { defaultKey } : {}),
  }),
  transform: (
    nodeId: string,
    output: ValueTemplate,
    assign?: Record<string, ValueTemplate>,
  ): TransformNode => ({
    id: id<NodeId>(nodeId),
    type: "transform",
    output,
    ...(assign ? { assign } : {}),
  }),
  join: (nodeId: string): JoinNode => ({ id: id<NodeId>(nodeId), type: "join" }),
  output: (value: ValueTemplate, nodeId = "end"): OutputNode => ({
    id: id<NodeId>(nodeId),
    type: "output",
    value,
  }),
  forEach: (
    nodeId: string,
    collection: ValueExpression,
    body: WorkflowGraph,
    options: { concurrency?: number; maxItems?: number } = {},
  ): ForEachNode => ({
    id: id<NodeId>(nodeId),
    type: "for_each",
    collection,
    concurrency: options.concurrency ?? 2,
    maxItems: options.maxItems ?? 100,
    body,
  }),
  while: (
    nodeId: string,
    condition: Condition,
    body: WorkflowGraph,
    maxIterations = 10,
  ): WhileNode => ({
    id: id<NodeId>(nodeId),
    type: "while",
    condition,
    maxIterations,
    body,
  }),
};

/** `a->b`形式の文字列、または`[source, target, branch]`からedgeを作る。 */
export function edges(...specs: (string | [string, string, string?])[]): WorkflowEdge[] {
  return specs.map((spec, index) => {
    const [source, target, branch] =
      typeof spec === "string" ? (spec.split("->") as [string, string]) : spec;
    return {
      id: `e${index}`,
      source: id<NodeId>(source),
      target: id<NodeId>(target),
      ...(branch !== undefined ? { branch } : {}),
    };
  });
}

export function graph(nodes: WorkflowNode[], edgeList: WorkflowEdge[]): WorkflowGraph {
  return { nodes, edges: edgeList };
}

export function definition(
  root: WorkflowGraph,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: id<WorkflowDefinitionId>("wf:test"),
    name: "test workflow",
    graph: root,
    ...extra,
  };
}

export function runId(value = "run:test"): WorkflowRunId {
  return id<WorkflowRunId>(value);
}
