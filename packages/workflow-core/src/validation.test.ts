import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowDefinition } from "./definition.ts";
import { TEST_ACTOR, definition, edges, f, graph, lit, n, obj } from "./testing/index.ts";
import { validateWorkflowDefinition } from "./validation.ts";
import { publishWorkflowVersion, verifyWorkflowVersion } from "./version.ts";

function codes(def: WorkflowDefinition): string[] {
  const result = validateWorkflowDefinition(def);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

const valid = definition(
  graph(
    [
      n.trigger(),
      n.action("onboard", "employee.onboard", obj({ name: f("workflow.input.name") })),
      n.output(f("nodes.onboard.output")),
    ],
    edges("start->onboard", "onboard->end"),
  ),
);

describe("workflow-core definition validation (#156)", () => {
  it("accepts a valid workflow that calls a Composite Action through an Action Node", () => {
    expect(codes(valid)).toEqual([]);
  });

  it("rejects arbitrary cycles (loops must use ForEach / While)", () => {
    expect(
      codes(
        definition(
          graph(
            [n.trigger(), n.transform("a", lit(1)), n.transform("b", lit(2)), n.output(lit(1))],
            edges("start->a", "a->b", "b->a", "b->end"),
          ),
        ),
      ),
    ).toContain("cycle_detected");
  });

  it("requires an explicit Join for multiple incoming control-flow edges", () => {
    expect(
      codes(
        definition(
          graph(
            [n.trigger(), n.transform("a", lit(1)), n.transform("b", lit(2)), n.output(lit(1))],
            edges("start->a", "start->b", "a->end", "b->end"),
          ),
        ),
      ),
    ).toContain("join_required");
  });

  it("rejects dangling edges, unreachable nodes, and invalid trigger / output counts", () => {
    expect(
      codes(
        definition(
          graph(
            [n.trigger(), n.transform("orphan", lit(1)), n.output(lit(1))],
            edges("start->end", "start->ghost"),
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(["dangling_edge"]));
    expect(
      codes(
        definition(
          graph(
            [
              n.trigger(),
              n.transform("a", lit(1)),
              n.transform("orphan", lit(1)),
              n.output(lit(1)),
            ],
            edges("start->a", "a->end", "orphan->end"),
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(["entry_not_trigger", "join_required"]));
    expect(codes(definition(graph([n.transform("a", lit(1))], [])))).toEqual(
      expect.arrayContaining(["trigger_count", "output_count"]),
    );
  });

  it("validates branch edges against case keys", () => {
    expect(
      codes(
        definition(
          graph(
            [
              n.trigger(),
              n.branch("route", [
                {
                  key: "yes",
                  when: { type: "comparison", left: lit(1), operator: "eq", right: lit(1) },
                },
              ]),
              n.transform("a", lit(1)),
              n.output(lit(1)),
            ],
            edges("start->route", ["route", "a", "no"], "a->end"),
          ),
        ),
      ),
    ).toContain("branch_edge_invalid");
  });

  it("requires maxIterations for While and bounds ForEach", () => {
    const whileNode = n.while(
      "loop",
      { type: "comparison", left: lit(1), operator: "eq", right: lit(1) },
      graph([n.transform("t", lit(1))], []),
    );
    const missing = { ...whileNode, maxIterations: undefined as unknown as number };
    expect(
      codes(
        definition(
          graph([n.trigger(), missing, n.output(lit(1))], edges("start->loop", "loop->end")),
        ),
      ),
    ).toContain("while_max_iterations");
    expect(
      codes(
        definition(
          graph(
            [
              n.trigger(),
              n.forEach("each", f("workflow.input.items"), graph([n.transform("t", lit(1))], []), {
                concurrency: 0,
                maxItems: 100_000,
              }),
              n.output(lit(1)),
            ],
            edges("start->each", "each->end"),
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(["for_each_concurrency", "for_each_max_items"]));
  });

  it("rejects references to non-upstream nodes, loop fields outside loops, and foreign namespaces", () => {
    expect(
      codes(
        definition(
          graph(
            [
              n.trigger(),
              n.transform("a", f("nodes.b.output")),
              n.transform("b", lit(1)),
              n.output(f("loop.item")),
            ],
            edges("start->a", "a->b", "b->end"),
          ),
        ),
      ),
    ).toEqual(
      expect.arrayContaining(["node_reference_not_upstream", "loop_reference_outside_loop"]),
    );
    expect(
      codes(
        definition(graph([n.trigger(), n.output(f("action.input.amount"))], edges("start->end"))),
      ),
    ).toContain("field_not_allowed");
    expect(
      codes(
        definition(graph([n.trigger(), n.output(f("nodes.nope.output"))], edges("start->end"))),
      ),
    ).toContain("node_reference_unknown");
  });

  it("allows loop bodies to reference upstream nodes of the enclosing scope", () => {
    expect(
      codes(
        definition(
          graph(
            [
              n.trigger(),
              n.transform("prep", lit({ x: 1 })),
              n.forEach(
                "each",
                f("workflow.input.items"),
                graph(
                  [n.transform("use", obj({ prep: f("nodes.prep.output"), item: f("loop.item") }))],
                  [],
                ),
              ),
              n.output(f("nodes.each.output")),
            ],
            edges("start->prep", "prep->each", "each->end"),
          ),
        ),
      ),
    ).toEqual([]);
  });
});

describe("workflow version immutability (#156)", () => {
  it("published versions are frozen snapshots and new versions never modify old ones", async () => {
    const draft = structuredClone(valid);
    const v1 = await publishWorkflowVersion({
      definition: draft,
      latestVersion: null,
      publishedAt: "2026-09-25T00:00:00.000Z",
      publishedBy: TEST_ACTOR,
    });
    if (Result.isFailure(v1)) expect.fail(v1.error.message);
    expect(v1.value.version).toBe(1);
    expect(Object.isFrozen(v1.value.definition.graph.nodes)).toBe(true);
    // draftの編集はpublish済みsnapshotへ影響しない。
    draft.name = "renamed";
    expect(v1.value.definition.name).toBe("test workflow");

    const v2 = await publishWorkflowVersion({
      definition: draft,
      latestVersion: v1.value.version,
      publishedAt: "2026-09-26T00:00:00.000Z",
      publishedBy: TEST_ACTOR,
    });
    if (Result.isFailure(v2)) expect.fail(v2.error.message);
    expect(v2.value.version).toBe(2);
    expect(v2.value.checksum).not.toBe(v1.value.checksum);
    expect(Result.isSuccess(await verifyWorkflowVersion(v1.value))).toBe(true);

    const tampered = structuredClone(v1.value);
    tampered.definition.name = "tampered";
    const verified = await verifyWorkflowVersion(tampered);
    expect(Result.isFailure(verified) && verified.error.code).toBe("workflow_version_conflict");
  });

  it("invalid definitions cannot be published", async () => {
    const published = await publishWorkflowVersion({
      definition: definition(graph([n.trigger()], [])),
      latestVersion: null,
      publishedAt: "2026-09-25T00:00:00.000Z",
      publishedBy: TEST_ACTOR,
    });
    expect(Result.isFailure(published) && published.error.code).toBe("workflow_invalid");
  });
});
