import {
  DELEGATION_FIELD_NAMESPACES,
  WORKFLOW_FIELD_NAMESPACES,
  conditionValueExpressions,
  templateValueExpressions,
  validateValueExpressions,
} from "@app/expression-core";
import type { Condition, ValueExpression, ValueTemplate } from "@app/expression-core";

import { WORKFLOW_GLOBAL_LIMITS } from "./definition.ts";
import type {
  CapabilityGrant,
  RetryPolicy,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowNode,
} from "./definition.ts";
import {
  ancestorsOf,
  incomingEdges,
  outgoingEdges,
  topologicalOrder,
  visitGraphs,
} from "./graph.ts";
import { isValidNodeId } from "./ids.ts";
import type { NodeId } from "./ids.ts";

export type WorkflowValidationIssue = {
  code: string;
  /** 問題の位置（例: `graph.nodes[approve]` / `graph.nodes[loop].body.edges[e1]`）。 */
  location: string;
  message: string;
};

export type WorkflowValidationResult =
  | { valid: true }
  | { valid: false; issues: WorkflowValidationIssue[] };

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type Expressions = { expression: ValueExpression; location: string }[];

function graphLocation(path: readonly NodeId[]): string {
  return path.reduce<string>(
    (location, nodeId) => `${location}.nodes[${String(nodeId)}].body`,
    "graph",
  );
}

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** `nodes.<nodeId>.output...`が参照するNode ID。 */
function referencedNodeId(path: string): string | undefined {
  const segments = path.split(".");
  return segments[0] === "nodes" ? segments[1] : undefined;
}

type ScopeInfo = {
  /** このgraph（loop body）を持つloop Node。rootはundefined。 */
  loopNode?: WorkflowNode;
  /** 親graphで、このgraphから参照可能なNode ID（loop Nodeの祖先 + さらに外側）。 */
  inheritedVisible: Set<string>;
  depth: number;
};

class Validator {
  readonly issues: WorkflowValidationIssue[] = [];
  private readonly allNodeIds = new Set<string>();

  constructor(private readonly definition: WorkflowDefinition) {}

  add(code: string, location: string, message: string): void {
    this.issues.push({ code, location, message });
  }

  run(): WorkflowValidationIssue[] {
    const { definition } = this;
    if (typeof definition.name !== "string" || definition.name.trim().length === 0) {
      this.add("name_required", "name", "Workflow名が必要です");
    }
    this.validateLimits();
    this.validateVariables();
    for (const { graph } of visitGraphs(definition.graph)) {
      for (const node of graph.nodes) {
        if (this.allNodeIds.has(String(node.id))) {
          this.add(
            "duplicate_node_id",
            `node[${String(node.id)}]`,
            "Node IDは全graphで一意である必要があります",
          );
        }
        this.allNodeIds.add(String(node.id));
      }
    }
    this.validateGraph(definition.graph, [], {
      inheritedVisible: new Set(),
      depth: 0,
    });
    return this.issues;
  }

  private validateLimits(): void {
    const limits = this.definition.limits;
    if (!limits) return;
    if (
      limits.maxNodeRuns !== undefined &&
      !isIntegerIn(limits.maxNodeRuns, 1, WORKFLOW_GLOBAL_LIMITS.maxNodeRuns)
    ) {
      this.add(
        "limit_out_of_range",
        "limits.maxNodeRuns",
        `maxNodeRunsは1〜${WORKFLOW_GLOBAL_LIMITS.maxNodeRuns}の整数である必要があります`,
      );
    }
    if (
      limits.maxParallelEffects !== undefined &&
      !isIntegerIn(limits.maxParallelEffects, 1, WORKFLOW_GLOBAL_LIMITS.maxParallelEffects)
    ) {
      this.add(
        "limit_out_of_range",
        "limits.maxParallelEffects",
        `maxParallelEffectsは1〜${WORKFLOW_GLOBAL_LIMITS.maxParallelEffects}の整数である必要があります`,
      );
    }
  }

  private validateVariables(): void {
    for (const name of Object.keys(this.definition.variables ?? {})) {
      if (!VARIABLE_NAME.test(name)) {
        this.add("invalid_variable_name", `variables.${name}`, `不正なvariable名です: ${name}`);
      }
    }
  }

  private validateGraph(graph: WorkflowGraph, path: NodeId[], scope: ScopeInfo): void {
    const location = graphLocation(path);
    const isRoot = path.length === 0;
    if (graph.nodes.length > WORKFLOW_GLOBAL_LIMITS.maxNodesPerGraph) {
      this.add(
        "graph_too_large",
        location,
        `1 graphのNode数は${WORKFLOW_GLOBAL_LIMITS.maxNodesPerGraph}以下である必要があります`,
      );
    }
    if (graph.nodes.length === 0) {
      this.add("graph_empty", location, "graphには1つ以上のNodeが必要です");
      return;
    }

    const localIds = new Set(graph.nodes.map((node) => String(node.id)));
    for (const node of graph.nodes) {
      if (!isValidNodeId(String(node.id))) {
        this.add(
          "invalid_node_id",
          `${location}.nodes[${String(node.id)}]`,
          "Node IDは英字始まりの64文字以内の識別子（英数字・_・-）である必要があります",
        );
      }
    }

    const edgeIds = new Set<string>();
    let structurallyValid = true;
    for (const edge of graph.edges) {
      const edgeLocation = `${location}.edges[${edge.id}]`;
      if (edgeIds.has(edge.id)) {
        this.add("duplicate_edge_id", edgeLocation, "Edge IDはgraph内で一意である必要があります");
      }
      edgeIds.add(edge.id);
      if (!localIds.has(String(edge.source)) || !localIds.has(String(edge.target))) {
        this.add(
          "dangling_edge",
          edgeLocation,
          "Edgeのsource / targetは同じgraph内のNodeである必要があります",
        );
        structurallyValid = false;
      }
    }

    const order = structurallyValid ? topologicalOrder(graph) : null;
    if (structurallyValid && !order) {
      this.add(
        "cycle_detected",
        location,
        "graphにcycleがあります。繰り返しはForEach / While Nodeで表現してください",
      );
      structurallyValid = false;
    }

    const triggers = graph.nodes.filter((node) => node.type === "trigger");
    if (isRoot && triggers.length !== 1) {
      this.add("trigger_count", location, "root graphにはTrigger Nodeがちょうど1つ必要です");
    }
    if (!isRoot && triggers.length > 0) {
      this.add("trigger_in_body", location, "loop bodyにTrigger Nodeは置けません");
    }
    const outputs = graph.nodes.filter((node) => node.type === "output");
    if (isRoot && outputs.length !== 1) {
      this.add("output_count", location, "root graphにはOutput Nodeがちょうど1つ必要です");
    }
    if (!isRoot && outputs.length > 1) {
      this.add("output_count", location, "loop bodyのOutput Nodeは1つまでです");
    }

    const entries = graph.nodes.filter((node) => incomingEdges(graph, node.id).length === 0);
    if (isRoot) {
      for (const entry of entries) {
        if (entry.type !== "trigger") {
          this.add(
            "entry_not_trigger",
            `${location}.nodes[${String(entry.id)}]`,
            "root graphで入力edgeを持たないNodeはTriggerだけです",
          );
        }
      }
    } else if (entries.length === 0) {
      this.add("body_entry_missing", location, "loop bodyには入口Nodeが必要です");
    }

    if (structurallyValid) {
      const reachable = new Set<string>();
      const stack = entries.map((node) => String(node.id));
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || reachable.has(current)) continue;
        reachable.add(current);
        for (const edge of outgoingEdges(graph, current)) stack.push(String(edge.target));
      }
      for (const node of graph.nodes) {
        if (!reachable.has(String(node.id))) {
          this.add(
            "unreachable_node",
            `${location}.nodes[${String(node.id)}]`,
            "入口から到達できないNodeです",
          );
        }
      }
    }

    for (const node of graph.nodes) {
      this.validateNode(graph, node, path, scope, structurallyValid);
    }
  }

  private validateNode(
    graph: WorkflowGraph,
    node: WorkflowNode,
    path: NodeId[],
    scope: ScopeInfo,
    structurallyValid: boolean,
  ): void {
    const location = `${graphLocation(path)}.nodes[${String(node.id)}]`;
    const incoming = incomingEdges(graph, node.id);
    const outgoing = outgoingEdges(graph, node.id);

    if (node.type === "trigger" && incoming.length > 0) {
      this.add("trigger_has_incoming", location, "Trigger Nodeは入力edgeを持てません");
    }
    if (node.type === "join" && incoming.length < 2) {
      this.add("join_incoming", location, "Join Nodeには2つ以上の入力edgeが必要です");
    }
    if (node.type !== "join" && incoming.length > 1) {
      this.add(
        "join_required",
        location,
        "複数の入力edgeを合流させるには明示的なJoin Nodeが必要です",
      );
    }
    if (node.type === "output" && outgoing.length > 0) {
      this.add("output_has_outgoing", location, "Output Nodeは出力edgeを持てません");
    }

    if (node.type === "branch") {
      const keys = new Set<string>();
      if (node.cases.length === 0) {
        this.add("branch_no_cases", location, "Branch Nodeには1つ以上のcaseが必要です");
      }
      for (const branchCase of node.cases) {
        if (keys.has(branchCase.key)) {
          this.add(
            "branch_case_duplicate",
            location,
            `case keyが重複しています: ${branchCase.key}`,
          );
        }
        keys.add(branchCase.key);
      }
      if (node.defaultKey !== undefined) keys.add(node.defaultKey);
      for (const edge of outgoing) {
        if (edge.branch === undefined || !keys.has(edge.branch)) {
          this.add(
            "branch_edge_invalid",
            `${graphLocation(path)}.edges[${edge.id}]`,
            "Branchから出るedgeはcase keyまたはdefault keyを持つ必要があります",
          );
        }
      }
    } else {
      for (const edge of outgoing) {
        if (edge.branch !== undefined) {
          this.add(
            "branch_edge_invalid",
            `${graphLocation(path)}.edges[${edge.id}]`,
            "Branch以外のNodeから出るedgeはcase keyを持てません",
          );
        }
      }
    }

    if (
      node.type === "while" &&
      !isIntegerIn(node.maxIterations, 1, WORKFLOW_GLOBAL_LIMITS.maxWhileIterations)
    ) {
      this.add(
        "while_max_iterations",
        location,
        `WhileのmaxIterationsは必須で、1〜${WORKFLOW_GLOBAL_LIMITS.maxWhileIterations}の整数である必要があります`,
      );
    }
    if (node.type === "for_each") {
      if (!isIntegerIn(node.concurrency, 1, WORKFLOW_GLOBAL_LIMITS.maxForEachConcurrency)) {
        this.add(
          "for_each_concurrency",
          location,
          `ForEachのconcurrencyは1〜${WORKFLOW_GLOBAL_LIMITS.maxForEachConcurrency}の整数である必要があります`,
        );
      }
      if (!isIntegerIn(node.maxItems, 1, WORKFLOW_GLOBAL_LIMITS.maxForEachItems)) {
        this.add(
          "for_each_max_items",
          location,
          `ForEachのmaxItemsは1〜${WORKFLOW_GLOBAL_LIMITS.maxForEachItems}の整数である必要があります`,
        );
      }
    }
    if (node.type === "action") {
      if (String(node.actionType).trim().length === 0) {
        this.add("action_type_required", location, "Action NodeにはactionTypeが必要です");
      }
      if (node.resource.type.trim().length === 0) {
        this.add("resource_type_required", location, "Action Nodeにはresource typeが必要です");
      }
      this.validateRetry(node.retry, location);
    }
    if (node.type === "llm") {
      if (node.model.trim().length === 0) {
        this.add("llm_model_required", location, "LLM Nodeにはmodelが必要です");
      }
      if (!isIntegerIn(node.maxOutputTokens, 1, 32_768)) {
        this.add(
          "llm_max_output_tokens",
          location,
          "maxOutputTokensは1〜32768の整数である必要があります",
        );
      }
    }
    if (node.type === "program" || node.type === "llm") {
      this.validateCapabilityGrant(node.capabilities, location);
    }
    if (node.type === "transform") {
      for (const name of Object.keys(node.assign ?? {})) {
        if (!VARIABLE_NAME.test(name)) {
          this.add(
            "invalid_variable_name",
            `${location}.assign.${name}`,
            `不正なvariable名です: ${name}`,
          );
        }
      }
    }

    this.validateExpressions(graph, node, path, scope, location, structurallyValid);

    if (node.type === "for_each" || node.type === "while") {
      const depth = scope.depth + 1;
      if (depth > WORKFLOW_GLOBAL_LIMITS.maxLoopNesting) {
        this.add(
          "loop_nesting_too_deep",
          location,
          `loopのnestは${WORKFLOW_GLOBAL_LIMITS.maxLoopNesting}段までです`,
        );
        return;
      }
      const visible = new Set([
        ...scope.inheritedVisible,
        ...(structurallyValid ? ancestorsOf(graph, node.id) : []),
      ]);
      this.validateGraph(node.body, [...path, node.id], {
        loopNode: node,
        inheritedVisible: visible,
        depth,
      });
    }
  }

  private validateRetry(retry: RetryPolicy | undefined, location: string): void {
    if (!retry) return;
    if (!isIntegerIn(retry.maxAttempts, 1, WORKFLOW_GLOBAL_LIMITS.maxRetryAttempts)) {
      this.add(
        "retry_out_of_range",
        `${location}.retry.maxAttempts`,
        `maxAttemptsは1〜${WORKFLOW_GLOBAL_LIMITS.maxRetryAttempts}の整数である必要があります`,
      );
    }
    if (!isIntegerIn(retry.backoffSeconds, 0, 3600)) {
      this.add(
        "retry_out_of_range",
        `${location}.retry.backoffSeconds`,
        "backoffSecondsは0〜3600の整数です",
      );
    }
  }

  private validateCapabilityGrant(grant: CapabilityGrant | undefined, location: string): void {
    if (!grant) return;
    for (const [index, action] of (grant.actions ?? []).entries()) {
      if (String(action.actionType).trim().length === 0) {
        this.add(
          "capability_invalid",
          `${location}.capabilities.actions[${index}]`,
          "actionTypeが必要です",
        );
      }
      if (action.restriction) {
        this.addExpressionIssues(
          validateValueExpressions(
            conditionValueExpressions(
              action.restriction,
              `${location}.capabilities.actions[${index}].restriction`,
            ),
            DELEGATION_FIELD_NAMESPACES,
          ),
        );
      }
    }
    const llm = grant.llm;
    if (llm) {
      const bounded =
        isIntegerIn(llm.maxCalls, 0, 1000) &&
        isIntegerIn(llm.maxInputTokens, 0, 1_000_000) &&
        isIntegerIn(llm.maxOutputTokens, 0, 1_000_000) &&
        isIntegerIn(llm.maxCostMicroUsd, 0, 1_000_000_000);
      if (!bounded || llm.models.length === 0) {
        this.add(
          "capability_invalid",
          `${location}.capabilities.llm`,
          "LLM capabilityのmodel / budgetが不正です",
        );
      }
    }
    if (grant.maxEffects !== undefined && !isIntegerIn(grant.maxEffects, 0, 1000)) {
      this.add(
        "capability_invalid",
        `${location}.capabilities.maxEffects`,
        "maxEffectsは0〜1000の整数です",
      );
    }
  }

  private addExpressionIssues(issues: { code: string; location: string; message: string }[]): void {
    for (const issue of issues) this.add(issue.code, issue.location, issue.message);
  }

  private nodeExpressions(node: WorkflowNode, location: string): Expressions {
    const template = (value: ValueTemplate, at: string) => templateValueExpressions(value, at);
    const condition = (value: Condition, at: string) => conditionValueExpressions(value, at);
    switch (node.type) {
      case "action":
        return [
          { expression: node.resource.id, location: `${location}.resource.id` },
          ...template(node.input, `${location}.input`),
        ];
      case "branch":
        return node.cases.flatMap((branchCase, index) =>
          condition(branchCase.when, `${location}.cases[${index}].when`),
        );
      case "for_each":
        return [{ expression: node.collection, location: `${location}.collection` }];
      case "while":
        return condition(node.condition, `${location}.condition`);
      case "transform":
        return [
          ...template(node.output, `${location}.output`),
          ...Object.entries(node.assign ?? {}).flatMap(([name, value]) =>
            template(value, `${location}.assign.${name}`),
          ),
        ];
      case "program":
        return template(node.input, `${location}.input`);
      case "llm":
        return template(node.prompt, `${location}.prompt`);
      case "output":
        return template(node.value, `${location}.value`);
      case "trigger":
      case "join":
        return [];
    }
  }

  private validateExpressions(
    graph: WorkflowGraph,
    node: WorkflowNode,
    path: NodeId[],
    scope: ScopeInfo,
    location: string,
    structurallyValid: boolean,
  ): void {
    const expressions = this.nodeExpressions(node, location);
    this.addExpressionIssues(validateValueExpressions(expressions, WORKFLOW_FIELD_NAMESPACES));
    if (node.type === "action" && node.restriction) {
      this.addExpressionIssues(
        validateValueExpressions(
          conditionValueExpressions(node.restriction, `${location}.restriction`),
          DELEGATION_FIELD_NAMESPACES,
        ),
      );
    }

    const visible = new Set([
      ...scope.inheritedVisible,
      ...(structurallyValid ? ancestorsOf(graph, node.id) : []),
    ]);
    const insideLoop = path.length > 0;
    for (const { expression, location: at } of expressions) {
      if (expression.type !== "field") continue;
      const referenced = referencedNodeId(expression.path);
      if (referenced !== undefined) {
        if (!this.allNodeIds.has(referenced)) {
          this.add("node_reference_unknown", at, `存在しないNodeを参照しています: ${referenced}`);
        } else if (!visible.has(referenced)) {
          this.add(
            "node_reference_not_upstream",
            at,
            `上流で実行済みになることが保証されないNodeを参照しています: ${referenced}`,
          );
        }
      }
      const loopRoot = expression.path.split(".")[0] === "loop";
      const whileIndex = node.type === "while" && expression.path === "loop.index";
      if (loopRoot && !insideLoop && !whileIndex) {
        this.add("loop_reference_outside_loop", at, "loop.*はloop bodyの中でだけ参照できます");
      }
    }
  }
}

/** 実行前にWorkflow Definitionのgraph / control flow / 式参照を検証する（fail-fast）。 */
export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowValidationResult {
  const issues = new Validator(definition).run();
  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}
