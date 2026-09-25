import { describe, expect, it } from "vite-plus/test";

import { analyzeNodeReachability } from "./analysis.ts";
import { edges, eq, graph, lit, n } from "./testing/index.ts";

describe("static node reachability (#159)", () => {
  it("marks branch-dependent paths and loop bodies as conditional, joins after branches as always", () => {
    const reach = analyzeNodeReachability(
      graph(
        [
          n.trigger(),
          n.transform("fanout_a", lit(1)),
          n.branch("route", [{ key: "yes", when: eq(lit(1), lit(1)) }], "no"),
          n.transform("yes_path", lit(1)),
          n.transform("no_path", lit(1)),
          n.join("merge"),
          n.forEach("each", lit([]), graph([n.transform("body", lit(1))], [])),
          n.output(lit(null)),
        ],
        edges(
          "start->fanout_a",
          "fanout_a->route",
          ["route", "yes_path", "yes"],
          ["route", "no_path", "no"],
          "yes_path->merge",
          "no_path->merge",
          "merge->each",
          "each->end",
        ),
      ),
    );
    expect(reach.get("fanout_a")?.reachability).toBe("always");
    expect(reach.get("yes_path")?.reachability).toBe("conditional");
    expect(reach.get("no_path")?.reachability).toBe("conditional");
    // Branchの全caseが合流するJoinは、どのcaseでも実行される。
    expect(reach.get("merge")?.reachability).toBe("always");
    expect(reach.get("each")?.reachability).toBe("always");
    expect(reach.get("body")).toMatchObject({
      reachability: "conditional",
      repeated: true,
      loopPath: ["each"],
    });
  });
});
