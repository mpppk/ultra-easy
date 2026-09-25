import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { parseWorkflowDefinition } from "./parse.ts";
import { definition, edges, f, graph, n, obj } from "./testing/index.ts";

describe("parseWorkflowDefinition (#162 boundary)", () => {
  it("accepts well-formed definitions and rejects malformed JSON without crashing", () => {
    const valid = definition(
      graph(
        [
          n.trigger(),
          n.action("a", "x.y", obj({ v: f("workflow.input.v") })),
          n.output(f("nodes.a.output")),
        ],
        edges("start->a", "a->end"),
      ),
    );
    expect(Result.isSuccess(parseWorkflowDefinition(JSON.parse(JSON.stringify(valid))))).toBe(true);
    for (const broken of [
      null,
      { id: "x", name: "x" },
      { id: "x", name: "x", graph: { nodes: [{ id: "a", type: "rm-rf" }], edges: [] } },
      {
        id: "x",
        name: "x",
        graph: {
          nodes: [{ id: "a", type: "action", actionType: "t", resource: {}, input: 1 }],
          edges: [],
        },
      },
      {
        id: "x",
        name: "x",
        graph: {
          nodes: [{ id: "a", type: "branch", cases: [{ key: "k", when: { type: "eval" } }] }],
          edges: [],
        },
      },
    ]) {
      expect(Result.isFailure(parseWorkflowDefinition(broken))).toBe(true);
    }
  });
});
