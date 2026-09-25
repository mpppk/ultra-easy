import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import {
  WORKFLOW_FIELD_NAMESPACES,
  createFieldResolver,
  evaluateCondition,
  evaluateValueExpression,
  evaluateValueTemplate,
  isPlainRecord,
} from "@app/expression-core";
import type { ExpressionError, FieldResolver, JsonObject, JsonValue } from "@app/expression-core";
import { parseBrand } from "@app/approval-core";
import type { ActionType, OrganizationId } from "@app/approval-core";

import { DEFAULT_WORKFLOW_LIMITS, WORKFLOW_GLOBAL_LIMITS } from "./definition.ts";
import type {
  ForEachNode,
  WhileNode,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowNode,
  WorkflowVersion,
} from "./definition.ts";
import { findNode, graphAtPath, incomingEdges, outgoingEdges, topologicalOrder } from "./graph.ts";
import { ROOT_SCOPE_ID, derivedWorkflowId } from "./ids.ts";
import type { EffectId, NodeRunId, ScopeId, WorkflowRunId } from "./ids.ts";
import type { ProgramEffect } from "./program.ts";
import { isEffectInFlight, isTerminalNodeRunStatus, isTerminalWorkflowRunStatus } from "./state.ts";
import type {
  EffectOutcome,
  EffectRecord,
  EffectRequest,
  NodeRunState,
  ScopeState,
  WaitingReason,
  WorkflowFailure,
  WorkflowRunContext,
  WorkflowRunState,
} from "./state.ts";

/** Program sub-effectの失敗のうち、Programへ返さずNodeを失敗させる（fail-closed）code。 */
export const FATAL_EFFECT_FAILURE_CODES = new Set([
  "capability_denied",
  "quota_exceeded",
  "budget_exhausted",
  "effect_limit_exceeded",
]);

const DEFAULT_PROGRAM_MAX_EFFECTS = 16;

export type WorkflowRunEvent =
  | { type: "effect_dispatched"; effectId: EffectId; reference?: string }
  | { type: "effect_waiting"; effectId: EffectId; reason: WaitingReason }
  | { type: "effect_completed"; effectId: EffectId; output: JsonValue }
  | {
      type: "effect_failed";
      effectId: EffectId;
      code: string;
      message: string;
      retriable?: boolean;
    }
  | { type: "program_yielded"; effectId: EffectId; state: JsonValue; effect: ProgramEffect }
  | { type: "effect_cancel_propagated"; effectId: EffectId }
  | { type: "cancel"; reason: string };

export type WorkflowEventOutcome = "applied" | "duplicate" | "stale";

export class WorkflowEventRejectedError extends ErrorFactory({
  name: "WorkflowEventRejectedError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{
    code: "unknown_effect" | "event_not_applicable";
    detail: string;
  }>(),
}) {}

function scopeKey(scopeId: ScopeId, edgeId: string): string {
  return `${String(scopeId)}|${edgeId}`;
}

function nodeRunIdOf(scopeId: ScopeId, nodeId: string): NodeRunId {
  return derivedWorkflowId("NodeRunId", `${String(scopeId)}:${nodeId}`);
}

function iterationScopeId(parent: ScopeId, loopNodeId: string, index: number): ScopeId {
  return derivedWorkflowId("ScopeId", `${String(parent)}/${loopNodeId}[${index}]`);
}

function effectIdOf(nodeRunId: NodeRunId, attempt: number, suffix = ""): EffectId {
  return derivedWorkflowId("EffectId", `${String(nodeRunId)}#${attempt}${suffix}`);
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function expressionFailure(error: ExpressionError, nodeRunId: NodeRunId): WorkflowFailure {
  return {
    code: `expression_${error.code}`,
    message: error.message,
    nodeRunId,
  };
}

/** 1回のadvance / event適用を、clone済みstateへの変更として扱うkernel。 */
class Kernel {
  constructor(
    readonly state: WorkflowRunState,
    readonly definition: WorkflowDefinition,
    readonly now: string,
  ) {}

  private get maxNodeRuns(): number {
    return Math.min(
      this.definition.limits?.maxNodeRuns ?? DEFAULT_WORKFLOW_LIMITS.maxNodeRuns,
      WORKFLOW_GLOBAL_LIMITS.maxNodeRuns,
    );
  }

  private get maxParallelEffects(): number {
    return Math.min(
      this.definition.limits?.maxParallelEffects ?? DEFAULT_WORKFLOW_LIMITS.maxParallelEffects,
      WORKFLOW_GLOBAL_LIMITS.maxParallelEffects,
    );
  }

  private get terminal(): boolean {
    return isTerminalWorkflowRunStatus(this.state.status);
  }

  private graphOf(scope: ScopeState): WorkflowGraph | undefined {
    return graphAtPath(this.definition.graph, scope.path);
  }

  private scope(scopeId: ScopeId): ScopeState | undefined {
    return this.state.scopes[String(scopeId)];
  }

  private nodeRun(nodeRunId: NodeRunId): NodeRunState | undefined {
    return this.state.nodeRuns[String(nodeRunId)];
  }

  private nodeOf(nodeRun: NodeRunState): WorkflowNode | undefined {
    const scope = this.scope(nodeRun.scopeId);
    const graph = scope ? this.graphOf(scope) : undefined;
    return graph ? findNode(graph, nodeRun.nodeId) : undefined;
  }

  /** scopeから見えるNode outputとloop変数を持つ、式評価用の固定context。 */
  resolverFor(scope: ScopeState, loopOverride?: { index: number }): FieldResolver {
    const chain: ScopeState[] = [];
    let current: ScopeState | undefined = scope;
    while (current) {
      chain.unshift(current);
      current = current.parentScopeId ? this.scope(current.parentScopeId) : undefined;
    }
    const nodes: Record<string, { output: JsonValue }> = {};
    for (const link of chain) {
      for (const nodeRun of Object.values(this.state.nodeRuns)) {
        if (String(nodeRun.scopeId) !== String(link.id) || nodeRun.status !== "succeeded") continue;
        nodes[String(nodeRun.nodeId)] = { output: nodeRun.output ?? null };
      }
    }
    const innermost = [...chain].reverse().find((link) => link.iteration !== undefined);
    const loop = loopOverride
      ? { index: loopOverride.index }
      : innermost?.iteration
        ? {
            index: innermost.iteration.index,
            ...(innermost.iteration.item !== undefined ? { item: innermost.iteration.item } : {}),
          }
        : undefined;
    return createFieldResolver({
      policy: WORKFLOW_FIELD_NAMESPACES,
      dateTimeFields: ["now"],
      root: {
        workflow: { input: this.state.input },
        variables: this.state.variables,
        nodes,
        ...(loop ? { loop } : {}),
        actor: this.state.context.actor,
        organization: { settings: this.state.context.organizationSettings },
        attributes: this.state.context.attributes,
        now: this.now,
      },
    });
  }

  // ---------------------------------------------------------------- lifecycle

  run(): void {
    let guard = 0;
    let progress = true;
    while (progress && !this.terminal) {
      guard += 1;
      if (guard > 100_000) {
        this.failRun({ code: "scheduler_guard_exceeded", message: "schedulerが収束しません" });
        return;
      }
      progress = false;
      for (const scope of Object.values(this.state.scopes)) {
        if (this.terminal) return;
        if (scope.status !== "running") continue;
        if (this.stepScope(scope)) progress = true;
      }
    }
    if (this.terminal) return;
    const root = this.scope(ROOT_SCOPE_ID);
    if (root?.status === "succeeded") {
      this.state.status = "succeeded";
      this.state.output = root.output ?? null;
      this.state.completedAt = this.now;
      return;
    }
    const inFlight = Object.values(this.state.effects).some(isEffectInFlight);
    if (!inFlight) {
      this.failRun({
        code: "scheduler_stalled",
        message: "実行可能なNodeもin-flightの作用も無いままWorkflowが終端していません",
      });
      return;
    }
    this.state.status = "waiting";
  }

  private stepScope(scope: ScopeState): boolean {
    const graph = this.graphOf(scope);
    const order = graph ? topologicalOrder(graph) : null;
    if (!graph || !order) {
      this.failScope(scope, {
        code: "graph_invalid",
        message: `scopeのgraphを解決できません: ${String(scope.id)}`,
      });
      return true;
    }
    let progress = false;
    for (const nodeId of order) {
      if (this.terminal || scope.status !== "running") return true;
      const node = findNode(graph, nodeId);
      if (!node) continue;
      const nodeRun = this.ensureNodeRun(scope, node);
      if (!nodeRun) return true;
      if (nodeRun.status === "pending") {
        const readiness = this.readiness(scope, graph, node);
        if (readiness === "blocked") continue;
        progress = true;
        if (readiness === "skip") {
          nodeRun.status = "skipped";
          nodeRun.completedAt = this.now;
          this.setOutgoing(scope, graph, node, () => "not_taken");
          continue;
        }
        nodeRun.status = "ready";
      }
      if (nodeRun.status === "ready" && this.startNode(scope, graph, node, nodeRun)) {
        progress = true;
      }
    }
    if (scope.status === "running" && this.scopeComplete(scope, graph)) {
      this.completeScope(scope, graph);
      progress = true;
    }
    return progress;
  }

  private ensureNodeRun(scope: ScopeState, node: WorkflowNode): NodeRunState | undefined {
    const id = nodeRunIdOf(scope.id, String(node.id));
    const existing = this.nodeRun(id);
    if (existing) return existing;
    if (this.state.counters.nodeRuns >= this.maxNodeRuns) {
      this.failRun({
        code: "node_run_limit_exceeded",
        message: `NodeRun数が上限（${this.maxNodeRuns}）に達しました`,
      });
      return undefined;
    }
    this.state.counters.nodeRuns += 1;
    const created: NodeRunState = {
      id,
      scopeId: scope.id,
      nodeId: node.id,
      type: node.type,
      status: "pending",
      attempt: 1,
    };
    this.state.nodeRuns[String(id)] = created;
    return created;
  }

  private readiness(
    scope: ScopeState,
    graph: WorkflowGraph,
    node: WorkflowNode,
  ): "ready" | "skip" | "blocked" {
    const incoming = incomingEdges(graph, node.id);
    if (incoming.length === 0) return "ready";
    const activations = incoming.map((edge) => this.state.edges[scopeKey(scope.id, edge.id)]);
    if (activations.some((activation) => activation === undefined)) return "blocked";
    if (activations.every((activation) => activation === "not_taken")) return "skip";
    return "ready";
  }

  private setOutgoing(
    scope: ScopeState,
    graph: WorkflowGraph,
    node: WorkflowNode,
    activation: (edge: { branch?: string }) => "active" | "not_taken",
  ): void {
    for (const edge of outgoingEdges(graph, node.id)) {
      this.state.edges[scopeKey(scope.id, edge.id)] = activation(edge);
    }
  }

  private succeedNode(
    scope: ScopeState,
    graph: WorkflowGraph,
    node: WorkflowNode,
    nodeRun: NodeRunState,
    output: JsonValue,
    branchKey?: string,
  ): void {
    nodeRun.status = "succeeded";
    nodeRun.output = output;
    nodeRun.completedAt = this.now;
    delete nodeRun.waitingReason;
    delete nodeRun.effectId;
    this.setOutgoing(scope, graph, node, (edge) =>
      branchKey === undefined || edge.branch === branchKey ? "active" : "not_taken",
    );
  }

  private inFlightEffectCount(): number {
    return Object.values(this.state.effects).filter(
      (effect) => isEffectInFlight(effect) && effect.parentEffectId === undefined,
    ).length;
  }

  private requestEffect(
    nodeRun: NodeRunState,
    request: EffectRequest,
    options: { suffix?: string; parentEffectId?: EffectId; notBefore?: string } = {},
  ): EffectRecord {
    const id = effectIdOf(nodeRun.id, nodeRun.attempt, options.suffix);
    const effect: EffectRecord = {
      id,
      nodeRunId: nodeRun.id,
      request,
      status: "requested",
      requestedAt: this.now,
      ...(options.parentEffectId ? { parentEffectId: options.parentEffectId } : {}),
      ...(options.notBefore ? { notBefore: options.notBefore } : {}),
    };
    this.state.effects[String(id)] = effect;
    nodeRun.effectId = id;
    nodeRun.status = "running";
    nodeRun.startedAt ??= this.now;
    return effect;
  }

  /** ready Nodeを開始する。throttleで開始できなければfalse。 */
  private startNode(
    scope: ScopeState,
    graph: WorkflowGraph,
    node: WorkflowNode,
    nodeRun: NodeRunState,
  ): boolean {
    const effectful = node.type === "action" || node.type === "program" || node.type === "llm";
    if (effectful && this.inFlightEffectCount() >= this.maxParallelEffects) return false;
    nodeRun.startedAt ??= this.now;
    const resolver = this.resolverFor(scope);
    const fail = (error: ExpressionError) =>
      this.failNode(nodeRun, expressionFailure(error, nodeRun.id));

    switch (node.type) {
      case "trigger":
        this.succeedNode(scope, graph, node, nodeRun, this.state.input);
        return true;
      case "transform": {
        const output = evaluateValueTemplate(node.output, resolver);
        if (Result.isFailure(output)) {
          fail(output.error);
          return true;
        }
        for (const [name, template] of Object.entries(node.assign ?? {})) {
          const value = evaluateValueTemplate(template, resolver);
          if (Result.isFailure(value)) {
            fail(value.error);
            return true;
          }
          this.state.variables[name] = value.value;
        }
        this.succeedNode(scope, graph, node, nodeRun, output.value);
        return true;
      }
      case "branch": {
        let selected: string | undefined;
        for (const branchCase of node.cases) {
          const result = evaluateCondition(branchCase.when, resolver);
          if (Result.isFailure(result)) {
            fail(result.error);
            return true;
          }
          if (result.value.type === "matched") {
            selected = branchCase.key;
            break;
          }
        }
        selected ??= node.defaultKey;
        if (selected === undefined) {
          this.failNode(nodeRun, {
            code: "branch_no_matching_case",
            message: "どのcaseにも一致せず、default caseもありません",
            nodeRunId: nodeRun.id,
          });
          return true;
        }
        this.state.decisions.push({
          nodeRunId: nodeRun.id,
          kind: "branch",
          value: selected,
          decidedAt: this.now,
        });
        this.succeedNode(scope, graph, node, nodeRun, { selected }, selected);
        return true;
      }
      case "join": {
        const output: JsonObject = {};
        for (const edge of incomingEdges(graph, node.id)) {
          if (this.state.edges[scopeKey(scope.id, edge.id)] !== "active") continue;
          const source = this.nodeRun(nodeRunIdOf(scope.id, String(edge.source)));
          output[String(edge.source)] = source?.output ?? null;
        }
        this.succeedNode(scope, graph, node, nodeRun, output);
        return true;
      }
      case "output": {
        const value = evaluateValueTemplate(node.value, resolver);
        if (Result.isFailure(value)) {
          fail(value.error);
          return true;
        }
        scope.output = value.value;
        this.succeedNode(scope, graph, node, nodeRun, value.value);
        return true;
      }
      case "action": {
        const resourceId = evaluateValueExpression(node.resource.id, resolver);
        if (Result.isFailure(resourceId)) {
          fail(resourceId.error);
          return true;
        }
        const input = evaluateValueTemplate(node.input, resolver);
        if (Result.isFailure(input)) {
          fail(input.error);
          return true;
        }
        if (
          (typeof resourceId.value !== "string" && typeof resourceId.value !== "number") ||
          String(resourceId.value).length === 0 ||
          !isPlainRecord(input.value)
        ) {
          this.failNode(nodeRun, {
            code: "action_input_invalid",
            message: "Action Nodeのresource idは文字列、inputはobjectである必要があります",
            nodeRunId: nodeRun.id,
          });
          return true;
        }
        this.requestEffect(nodeRun, {
          kind: "action",
          actionType: node.actionType,
          resource: { type: node.resource.type, id: String(resourceId.value) },
          input: input.value as JsonObject,
          ...(node.restriction ? { restriction: node.restriction } : {}),
        });
        return true;
      }
      case "program": {
        const input = evaluateValueTemplate(node.input, resolver);
        if (Result.isFailure(input)) {
          fail(input.error);
          return true;
        }
        this.requestEffect(nodeRun, {
          kind: "program",
          program: node.program,
          input: input.value,
          ...(node.capabilities ? { capabilities: node.capabilities } : {}),
        });
        return true;
      }
      case "llm": {
        const prompt = evaluateValueTemplate(node.prompt, resolver);
        if (Result.isFailure(prompt)) {
          fail(prompt.error);
          return true;
        }
        this.requestEffect(nodeRun, {
          kind: "llm",
          model: node.model,
          prompt: prompt.value,
          maxOutputTokens: node.maxOutputTokens,
          ...(node.capabilities ? { capabilities: node.capabilities } : {}),
        });
        return true;
      }
      case "for_each":
        this.startForEach(scope, graph, node, nodeRun, resolver);
        return true;
      case "while":
        nodeRun.status = "running";
        nodeRun.loop = { kind: "while", iteration: 0, lastOutput: null };
        this.continueWhile(scope, graph, node, nodeRun);
        return true;
    }
  }

  // ---------------------------------------------------------------- loops

  private spawnIteration(
    scope: ScopeState,
    loopNode: WorkflowNode,
    nodeRun: NodeRunState,
    index: number,
    item?: JsonValue,
  ): ScopeId {
    const id = iterationScopeId(scope.id, String(loopNode.id), index);
    this.state.scopes[String(id)] = {
      id,
      parentScopeId: scope.id,
      loopNodeRunId: nodeRun.id,
      path: [...scope.path, loopNode.id],
      iteration: { index, ...(item !== undefined ? { item } : {}) },
      status: "running",
    };
    return id;
  }

  private startForEach(
    scope: ScopeState,
    graph: WorkflowGraph,
    node: ForEachNode,
    nodeRun: NodeRunState,
    resolver: FieldResolver,
  ): void {
    const collection = evaluateValueExpression(node.collection, resolver);
    if (Result.isFailure(collection)) {
      this.failNode(nodeRun, expressionFailure(collection.error, nodeRun.id));
      return;
    }
    if (!Array.isArray(collection.value)) {
      this.failNode(nodeRun, {
        code: "for_each_collection_not_array",
        message: "ForEachのcollectionは配列である必要があります",
        nodeRunId: nodeRun.id,
      });
      return;
    }
    const limit = Math.min(node.maxItems, WORKFLOW_GLOBAL_LIMITS.maxForEachItems);
    if (collection.value.length > limit) {
      this.failNode(nodeRun, {
        code: "for_each_too_many_items",
        message: `ForEachの要素数が上限（${limit}）を超えています`,
        nodeRunId: nodeRun.id,
      });
      return;
    }
    const items = collection.value;
    this.state.decisions.push({
      nodeRunId: nodeRun.id,
      kind: "for_each_items",
      value: items,
      decidedAt: this.now,
    });
    if (items.length === 0) {
      // 空のForEachはbody NodeRunを生成せず、downstreamを1回だけactivateする。
      this.succeedNode(scope, graph, node, nodeRun, []);
      return;
    }
    nodeRun.status = "running";
    nodeRun.loop = {
      kind: "for_each",
      items,
      nextIndex: 0,
      running: [],
      outputs: items.map(() => null),
      completed: 0,
    };
    this.fillForEach(scope, node, nodeRun);
  }

  private fillForEach(scope: ScopeState, node: ForEachNode, nodeRun: NodeRunState): void {
    const loop = nodeRun.loop;
    if (loop?.kind !== "for_each") return;
    const concurrency = Math.min(node.concurrency, WORKFLOW_GLOBAL_LIMITS.maxForEachConcurrency);
    while (loop.running.length < concurrency && loop.nextIndex < loop.items.length) {
      const index = loop.nextIndex;
      loop.running.push(
        this.spawnIteration(scope, node, nodeRun, index, loop.items[index] ?? null),
      );
      loop.nextIndex += 1;
    }
  }

  private continueWhile(
    scope: ScopeState,
    graph: WorkflowGraph,
    node: WhileNode,
    nodeRun: NodeRunState,
  ): void {
    const loop = nodeRun.loop;
    if (loop?.kind !== "while") return;
    const result = evaluateCondition(
      node.condition,
      this.resolverFor(scope, { index: loop.iteration }),
    );
    if (Result.isFailure(result)) {
      this.failNode(nodeRun, expressionFailure(result.error, nodeRun.id));
      return;
    }
    const proceed = result.value.type === "matched";
    this.state.decisions.push({
      nodeRunId: nodeRun.id,
      kind: proceed ? "while_continue" : "while_exit",
      value: proceed,
      iteration: loop.iteration,
      decidedAt: this.now,
    });
    if (!proceed) {
      this.succeedNode(scope, graph, node, nodeRun, {
        iterations: loop.iteration,
        last: loop.lastOutput,
      });
      return;
    }
    const limit = Math.min(node.maxIterations, WORKFLOW_GLOBAL_LIMITS.maxWhileIterations);
    if (loop.iteration >= limit) {
      this.failNode(nodeRun, {
        code: "while_max_iterations_exceeded",
        message: `Whileが上限（${limit}回）に達してもconditionを満たしています`,
        nodeRunId: nodeRun.id,
      });
      return;
    }
    loop.running = this.spawnIteration(scope, node, nodeRun, loop.iteration);
    loop.iteration += 1;
  }

  /** iteration scopeの成功を、生成元のloop NodeRunへ反映する。 */
  private iterationSucceeded(scope: ScopeState): void {
    if (!scope.loopNodeRunId || !scope.parentScopeId) return;
    const nodeRun = this.nodeRun(scope.loopNodeRunId);
    const parent = this.scope(scope.parentScopeId);
    if (!nodeRun || !parent || nodeRun.status !== "running") return;
    const graph = this.graphOf(parent);
    const node = graph ? findNode(graph, nodeRun.nodeId) : undefined;
    if (!graph || !node) return;
    const loop = nodeRun.loop;
    if (node.type === "for_each" && loop?.kind === "for_each") {
      loop.running = loop.running.filter((id) => String(id) !== String(scope.id));
      loop.outputs[scope.iteration?.index ?? 0] = scope.output ?? null;
      loop.completed += 1;
      if (loop.completed === loop.items.length) {
        this.succeedNode(parent, graph, node, nodeRun, loop.outputs);
        return;
      }
      this.fillForEach(parent, node, nodeRun);
      return;
    }
    if (node.type === "while" && loop?.kind === "while") {
      delete loop.running;
      loop.lastOutput = scope.output ?? null;
      this.continueWhile(parent, graph, node, nodeRun);
    }
  }

  // ---------------------------------------------------------------- scopes

  private scopeComplete(scope: ScopeState, graph: WorkflowGraph): boolean {
    return graph.nodes.every((node) => {
      const nodeRun = this.nodeRun(nodeRunIdOf(scope.id, String(node.id)));
      return (
        nodeRun !== undefined && (nodeRun.status === "succeeded" || nodeRun.status === "skipped")
      );
    });
  }

  private completeScope(scope: ScopeState, graph: WorkflowGraph): void {
    scope.status = "succeeded";
    if (scope.output === undefined) {
      const outputNode = graph.nodes.find((node) => node.type === "output");
      const outputRun = outputNode
        ? this.nodeRun(nodeRunIdOf(scope.id, String(outputNode.id)))
        : undefined;
      scope.output = outputRun?.status === "succeeded" ? (outputRun.output ?? null) : null;
    }
    this.iterationSucceeded(scope);
  }

  /** scope内（とそのnested scope）の未終端NodeRun / 作用をcancelする。 */
  private cancelScope(scope: ScopeState, status: "failed" | "cancelled"): void {
    scope.status = status;
    for (const nodeRun of Object.values(this.state.nodeRuns)) {
      if (String(nodeRun.scopeId) !== String(scope.id)) continue;
      if (isTerminalNodeRunStatus(nodeRun.status)) continue;
      this.cancelNodeRun(nodeRun);
    }
  }

  private cancelNodeRun(nodeRun: NodeRunState): void {
    nodeRun.status = "cancelled";
    nodeRun.completedAt = this.now;
    delete nodeRun.waitingReason;
    for (const effect of Object.values(this.state.effects)) {
      if (String(effect.nodeRunId) !== String(nodeRun.id) || !isEffectInFlight(effect)) continue;
      const dispatched = effect.status === "in_flight";
      effect.status = "cancelled";
      effect.completedAt = this.now;
      // 未配送の作用は外部に存在しないため伝播不要。in-flightはruntimeがchildへcancelを伝播する。
      effect.cancelPropagated = !dispatched;
    }
    for (const child of Object.values(this.state.scopes)) {
      if (String(child.loopNodeRunId) === String(nodeRun.id) && child.status === "running") {
        this.cancelScope(child, "cancelled");
      }
    }
  }

  private failNode(nodeRun: NodeRunState, failure: WorkflowFailure): void {
    nodeRun.status = "failed";
    nodeRun.error = failure;
    nodeRun.completedAt = this.now;
    delete nodeRun.waitingReason;
    for (const effect of Object.values(this.state.effects)) {
      if (String(effect.nodeRunId) === String(nodeRun.id) && isEffectInFlight(effect)) {
        effect.status = "cancelled";
        effect.completedAt = this.now;
        effect.cancelPropagated = false;
      }
    }
    for (const child of Object.values(this.state.scopes)) {
      if (String(child.loopNodeRunId) === String(nodeRun.id) && child.status === "running") {
        this.cancelScope(child, "cancelled");
      }
    }
    const scope = this.scope(nodeRun.scopeId);
    if (scope) this.failScope(scope, failure);
  }

  /** v1 fail-fast: active path / iterationの未処理失敗はenclosing scopeを失敗させる。 */
  private failScope(scope: ScopeState, failure: WorkflowFailure): void {
    if (scope.status !== "running") return;
    this.cancelScope(scope, "failed");
    if (scope.loopNodeRunId) {
      const loopRun = this.nodeRun(scope.loopNodeRunId);
      if (loopRun && !isTerminalNodeRunStatus(loopRun.status)) {
        this.failNode(loopRun, failure);
      }
      return;
    }
    this.failRun(failure);
  }

  failRun(failure: WorkflowFailure): void {
    if (this.terminal) return;
    for (const scope of Object.values(this.state.scopes)) {
      if (scope.status === "running") this.cancelScope(scope, "cancelled");
    }
    const root = this.scope(ROOT_SCOPE_ID);
    if (root && root.status === "cancelled") root.status = "failed";
    this.state.status = "failed";
    this.state.error = failure;
    this.state.completedAt = this.now;
  }

  cancelRun(reason: string): void {
    if (this.terminal) return;
    for (const scope of Object.values(this.state.scopes)) {
      if (scope.status === "running") this.cancelScope(scope, "cancelled");
    }
    this.state.status = "cancelled";
    this.state.error = { code: "workflow_cancelled", message: reason };
    this.state.completedAt = this.now;
  }

  // ---------------------------------------------------------------- events

  apply(event: WorkflowRunEvent): Result.Result<WorkflowEventOutcome, WorkflowEventRejectedError> {
    if (event.type === "cancel") {
      if (this.terminal) return Result.succeed("duplicate");
      this.cancelRun(event.reason);
      return Result.succeed("applied");
    }
    const effect = this.state.effects[String(event.effectId)];
    if (!effect) {
      return Result.fail(
        new WorkflowEventRejectedError({
          code: "unknown_effect",
          detail: `このWorkflowRunに存在しない作用です: ${String(event.effectId)}`,
        }),
      );
    }
    if (event.type === "effect_cancel_propagated") {
      if (effect.status !== "cancelled" || effect.cancelPropagated)
        return Result.succeed("duplicate");
      effect.cancelPropagated = true;
      return Result.succeed("applied");
    }
    if (event.type === "effect_dispatched") {
      if (effect.status !== "requested") return Result.succeed("duplicate");
      effect.status = "in_flight";
      if (event.reference !== undefined) effect.reference = event.reference;
      return Result.succeed("applied");
    }
    if (!isEffectInFlight(effect)) {
      // 終端済み作用への再送（replay）や、cancel後に届いた完了は状態を変えない。
      return Result.succeed(effect.status === "cancelled" ? "stale" : "duplicate");
    }
    const nodeRun = this.nodeRun(effect.nodeRunId);
    if (!nodeRun || isTerminalNodeRunStatus(nodeRun.status)) return Result.succeed("stale");

    switch (event.type) {
      case "effect_waiting":
        effect.status = "in_flight";
        nodeRun.status = "waiting";
        nodeRun.waitingReason = event.reason;
        return Result.succeed("applied");
      case "effect_completed":
        this.completeEffect(effect, nodeRun, { type: "completed", output: event.output });
        return Result.succeed("applied");
      case "effect_failed":
        this.completeEffect(
          effect,
          nodeRun,
          { type: "failed", code: event.code, message: event.message },
          event.retriable === true,
        );
        return Result.succeed("applied");
      case "program_yielded":
        this.programYielded(effect, nodeRun, event.state, event.effect);
        return Result.succeed("applied");
    }
  }

  private completeEffect(
    effect: EffectRecord,
    nodeRun: NodeRunState,
    outcome: EffectOutcome,
    retriable = false,
  ): void {
    effect.status = outcome.type === "completed" ? "completed" : "failed";
    effect.outcome = outcome;
    effect.completedAt = this.now;
    const node = this.nodeOf(nodeRun);
    const scope = this.scope(nodeRun.scopeId);
    const graph = scope ? this.graphOf(scope) : undefined;
    if (!node || !scope || !graph) return;

    if (effect.parentEffectId) {
      // Programがyieldした作用の結果で、Programを新しいsandbox invocationとして再開する。
      if (outcome.type === "failed" && FATAL_EFFECT_FAILURE_CODES.has(outcome.code)) {
        this.failNode(nodeRun, {
          code: outcome.code,
          message: outcome.message,
          nodeRunId: nodeRun.id,
        });
        return;
      }
      const parent = this.state.effects[String(effect.parentEffectId)];
      if (!parent || parent.request.kind !== "program") return;
      const count = nodeRun.yieldCount ?? 0;
      this.requestEffect(
        nodeRun,
        {
          ...parent.request,
          resume: { state: nodeRun.programState ?? null, effectResult: outcome },
        },
        { suffix: `.r${count}` },
      );
      return;
    }

    if (outcome.type === "completed") {
      this.succeedNode(scope, graph, node, nodeRun, outcome.output);
      return;
    }
    const maxAttempts = node.type === "action" ? (node.retry?.maxAttempts ?? 1) : 1;
    if (retriable && nodeRun.attempt < maxAttempts && node.type === "action") {
      nodeRun.attempt += 1;
      this.requestEffect(nodeRun, effect.request, {
        notBefore: addSeconds(this.now, node.retry?.backoffSeconds ?? 0),
      });
      return;
    }
    this.failNode(nodeRun, { code: outcome.code, message: outcome.message, nodeRunId: nodeRun.id });
  }

  private programYielded(
    effect: EffectRecord,
    nodeRun: NodeRunState,
    state: JsonValue,
    yielded: ProgramEffect,
  ): void {
    effect.status = "completed";
    effect.outcome = { type: "completed", output: { yielded: yielded.type } };
    effect.completedAt = this.now;
    const count = (nodeRun.yieldCount ?? 0) + 1;
    nodeRun.yieldCount = count;
    nodeRun.programState = state;
    const request = effect.request;
    const maxEffects =
      request.kind === "program"
        ? (request.capabilities?.maxEffects ?? DEFAULT_PROGRAM_MAX_EFFECTS)
        : DEFAULT_PROGRAM_MAX_EFFECTS;
    if (count > maxEffects) {
      this.failNode(nodeRun, {
        code: "effect_limit_exceeded",
        message: `Programがyieldできる作用の上限（${maxEffects}）を超えました`,
        nodeRunId: nodeRun.id,
      });
      return;
    }
    let actionType: ActionType | undefined;
    if (yielded.type === "action") {
      const parsed = parseBrand("ActionType", yielded.actionType);
      if (Result.isFailure(parsed)) {
        this.failNode(nodeRun, {
          code: "program_result_invalid",
          message: "Programが要求したactionTypeが不正です",
          nodeRunId: nodeRun.id,
        });
        return;
      }
      actionType = parsed.value;
    }
    const subRequest: EffectRequest | undefined =
      yielded.type === "action" && actionType
        ? {
            kind: "action",
            actionType,
            resource: yielded.resource,
            input: yielded.input,
          }
        : yielded.type === "llm"
          ? {
              kind: "llm",
              model: yielded.model,
              prompt: yielded.prompt,
              maxOutputTokens: yielded.maxOutputTokens,
              ...(request.kind === "program" && request.capabilities
                ? { capabilities: request.capabilities }
                : {}),
            }
          : yielded.type === "timer"
            ? { kind: "timer", seconds: yielded.seconds }
            : yielded.type === "human_input"
              ? { kind: "human_input", prompt: yielded.prompt }
              : undefined;
    if (!subRequest) return;
    this.requestEffect(nodeRun, subRequest, {
      suffix: `.y${count}`,
      parentEffectId: effect.id,
    });
  }
}

function clone(state: WorkflowRunState): WorkflowRunState {
  return structuredClone(state);
}

/** 新しいWorkflowRunを開始し、外部作用が必要になるまで進める（pure）。 */
export function startWorkflowRun(input: {
  runId: WorkflowRunId;
  organizationId: OrganizationId;
  version: WorkflowVersion;
  input: JsonObject;
  context: WorkflowRunContext;
  now: string;
}): WorkflowRunState {
  const state: WorkflowRunState = {
    runId: input.runId,
    organizationId: input.organizationId,
    definitionId: input.version.definitionId,
    version: input.version.version,
    checksum: input.version.checksum,
    status: "running",
    input: structuredClone(input.input),
    variables: structuredClone(input.version.definition.variables ?? {}),
    context: structuredClone(input.context),
    scopes: {
      [String(ROOT_SCOPE_ID)]: { id: ROOT_SCOPE_ID, path: [], status: "running" },
    },
    nodeRuns: {},
    edges: {},
    decisions: [],
    effects: {},
    counters: { nodeRuns: 0 },
    createdAt: input.now,
    updatedAt: input.now,
  };
  const kernel = new Kernel(state, input.version.definition, input.now);
  kernel.run();
  return state;
}

/** 永続化済みstateからschedulerを進める（resume）。決定済みのbranch / loopは再評価しない。 */
export function advanceWorkflowRun(
  state: WorkflowRunState,
  definition: WorkflowDefinition,
  now: string,
): WorkflowRunState {
  const next = clone(state);
  if (isTerminalWorkflowRunStatus(next.status)) return next;
  next.status = "running";
  next.updatedAt = now;
  new Kernel(next, definition, now).run();
  return next;
}

/** 外部作用の結果等のeventを適用して進める。重複・stale eventは状態を変えない。 */
export function applyWorkflowRunEvent(
  state: WorkflowRunState,
  definition: WorkflowDefinition,
  event: WorkflowRunEvent,
  now: string,
): Result.Result<
  { state: WorkflowRunState; outcome: WorkflowEventOutcome },
  WorkflowEventRejectedError
> {
  const next = clone(state);
  const kernel = new Kernel(next, definition, now);
  const outcome = kernel.apply(event);
  if (Result.isFailure(outcome)) return outcome;
  if (outcome.value !== "applied") return Result.succeed({ state, outcome: outcome.value });
  next.updatedAt = now;
  if (!isTerminalWorkflowRunStatus(next.status)) {
    next.status = "running";
    kernel.run();
  }
  return Result.succeed({ state: next, outcome: outcome.value });
}

/** runtimeが配送すべき作用（未配送・backoff満了）。 */
export function dispatchableEffects(state: WorkflowRunState, now: string): EffectRecord[] {
  return Object.values(state.effects).filter(
    (effect) =>
      effect.status === "requested" &&
      (effect.notBefore === undefined || Date.parse(effect.notBefore) <= Date.parse(now)),
  );
}

/** cancelされたがchildへ未伝播のin-flight作用。 */
export function cancellationsToPropagate(state: WorkflowRunState): EffectRecord[] {
  return Object.values(state.effects).filter(
    (effect) => effect.status === "cancelled" && effect.cancelPropagated === false,
  );
}

/** backoff中の作用のうち最も早い配送可能時刻。 */
export function nextEffectWakeAt(state: WorkflowRunState): string | undefined {
  return Object.values(state.effects)
    .filter((effect) => effect.status === "requested" && effect.notBefore !== undefined)
    .map((effect) => effect.notBefore as string)
    .sort()[0];
}
