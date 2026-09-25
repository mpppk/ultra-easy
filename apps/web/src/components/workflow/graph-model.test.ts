import { describe, expect, it } from "vite-plus/test";

import { validateWorkflowDefinition } from "@app/workflow-core";

import {
  createNode,
  emptyDefinition,
  graphAt,
  layoutGraph,
  nextNodeId,
  updateGraphAt,
} from "./graph-model.ts";

describe("Workflow Studio graph model (#162)", () => {
  it("builds a valid definition through editor operations, including loop bodies", () => {
    let definition = emptyDefinition("wf:studio", "studio");
    const actionId = nextNodeId(definition, "action");
    const loopId = nextNodeId(definition, "each");
    definition = updateGraphAt(definition, [], (graph) => ({
      nodes: [
        ...graph.nodes,
        createNode("action", actionId, { x: 0, y: 0 }),
        createNode("for_each", loopId, { x: 0, y: 0 }),
      ],
      edges: [
        { id: "e1", source: "start" as never, target: actionId as never },
        { id: "e2", source: actionId as never, target: loopId as never },
        { id: "e3", source: loopId as never, target: "end" as never },
      ],
    }));
    expect(validateWorkflowDefinition(definition)).toEqual({ valid: true });
    expect(graphAt(definition, [loopId])?.nodes).toHaveLength(1);
    const edited = updateGraphAt(definition, [loopId], (graph) => ({
      ...graph,
      nodes: [...graph.nodes, createNode("transform", "extra", { x: 0, y: 0 })],
    }));
    expect(graphAt(edited, [loopId])?.nodes.map((node) => String(node.id))).toEqual([
      `${loopId}_step`,
      "extra",
    ]);
    // 元のdefinitionは不変。
    expect(graphAt(definition, [loopId])?.nodes).toHaveLength(1);
  });

  it("lays out nodes without stored positions", () => {
    const definition = emptyDefinition("wf:layout", "layout");
    const positioned = layoutGraph(definition.graph, true);
    expect(positioned).toHaveLength(2);
    const [first, second] = positioned;
    expect((second?.y ?? 0) > (first?.y ?? 0)).toBe(true);
  });
});
