import { Result } from "@praha/byethrow";

import { newId, type SpaceRole } from "@app/knowledge-core";
import type { D1DatabaseLike } from "@app/knowledge-d1";

import {
  UltraEasyError,
  type ActionCorrelation,
  type ApprovalTaskRef,
  type AuditEventRef,
  type ChildActionRef,
  type CompiledPolicy,
  type HumanInputRequest,
  type KnowledgeActionType,
  type PolicyBindingView,
  type PrincipalRef,
  type RunNode,
  type RunStatus,
  type StartActionInput,
  type StartActionResult,
  type UltraEasyClient,
  type WorkflowRunView,
} from "../client.ts";
import type { DownstreamOutcome, McpDownstream } from "./downstream.ts";
import { analyzeMetadata, assessFreshness, type FreshnessVerdict } from "./llm.ts";
import { DEFAULT_KNOWLEDGE_POLICY, matchRule } from "./policy.ts";

/**
 * In-app stand-in for ultra-easy (ActionRequest API + Workflow Engine +
 * Approval + authorization relationships) until #154-#165 ship.
 *
 * It keeps ultra-easy semantics the Knowledge app relies on:
 * - Composite Actions run as WorkflowRuns; side effects are child ActionRequests
 *   with their own Authorization -> Approval -> Re-Authorization -> execution.
 * - Child execution goes through the Knowledge MCP endpoint (tools/call with an
 *   idempotency key), never by calling Knowledge code directly.
 * - Waiting states (approval / human input) are durable rows; resuming needs no
 *   process memory.
 *
 * Internal D1 failures reject and are converted to `platform_unavailable` at
 * the public boundary (see `guard`).
 */

export const MAINTENANCE_AGENT: PrincipalRef = {
  id: "service:knowledge-maintenance",
  displayName: "Knowledge maintenance agent",
};

const PUBLISH_NODES: Array<[string, string]> = [
  ["analyze_metadata", "Metadata analysis"],
  ["related_pages", "Related pages"],
  ["publication_approval", "Publication approval"],
  ["publish", "Publish"],
  ["reindex", "Search index"],
  ["notify", "Notify watchers"],
];

const MAINTENANCE_NODES: Array<[string, string]> = [
  ["list_stale", "Find stale pages"],
  ["analyze", "Freshness analysis"],
  ["owner_review", "Owner review"],
  ["apply", "Apply decisions"],
];

type ChildState = ChildActionRef & { resultData?: Record<string, unknown>; errorMessage?: string };

type MaintenanceItem = {
  pageId: string;
  title: string;
  ownerId: string;
  verdict: FreshnessVerdict | null;
  analysis: string;
  status: "analyze" | "branch" | "waiting_input" | "waiting_approval" | "done" | "failed";
  decision: string | null;
  resolution: string | null;
  childActionRequestId: string | null;
};

type RunState = {
  nodes: RunNode[];
  childActions: ChildState[];
  humanInputs: HumanInputRequest[];
  failure: WorkflowRunView["failure"];
  publish?: {
    snapshotId: string;
    pageId: string;
    pageOwnerId: string | null;
    visibility: string | null;
    sensitivity: string | null;
    publishChildId: string | null;
    reindexChildId: string | null;
    notifyChildId: string | null;
  };
  maintenance?: { spaceId: string; items: MaintenanceItem[] };
  single?: {
    toolName: string;
    input: Record<string, unknown>;
    pageOwnerId: string | null;
    childId: string | null;
  };
};

type RunRecord = {
  id: string;
  organizationId: string;
  actionRequestId: string;
  actionType: KnowledgeActionType;
  correlation: ActionCorrelation;
  status: RunStatus;
  state: RunState;
  requestedBy: PrincipalRef;
  startedAt: string;
  updatedAt: string;
};

type RunRow = {
  id: string;
  organization_id: string;
  action_request_id: string;
  action_type: KnowledgeActionType;
  space_id: string;
  page_id: string | null;
  publication_snapshot_id: string | null;
  status: RunStatus;
  state_json: string;
  requested_by_json: string;
  started_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  organization_id: string;
  action_request_id: string;
  run_id: string | null;
  action_type: string;
  summary_json: string;
  candidate_ids_json: string;
  requested_by: string;
  status: ApprovalTaskRef["status"];
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

export type ApprovalTaskView = ApprovalTaskRef & {
  organizationId: string;
  runId: string | null;
  requestedBy: PrincipalRef;
  candidates: PrincipalRef[];
  summary: Record<string, unknown>;
  decidedBy: PrincipalRef | null;
  decidedAt: string | null;
  createdAt: string;
};

const TOOL_FOR_ACTION: Record<string, string> = {
  "knowledge.revision.publish": "knowledge.revision.publish",
  "knowledge.search.reindex": "knowledge.search.reindex",
  "knowledge.watchers.notify": "knowledge.watchers.notify",
  "knowledge.page.archive": "knowledge.page.archive",
  "knowledge.page.mark_reviewed": "knowledge.page.mark_reviewed",
};

/** Minimal authorization model: which space roles may request an ActionType. */
const REQUIRED_ROLES: Record<string, readonly SpaceRole[]> = {
  "knowledge.publish_document": ["editor", "owner"],
  "knowledge.revision.publish": ["editor", "owner"],
  "knowledge.search.reindex": ["editor", "owner"],
  "knowledge.watchers.notify": ["editor", "owner"],
  "knowledge.maintain_space": ["owner"],
  "knowledge.page.mark_reviewed": ["owner"],
  "knowledge.page.archive": ["owner"],
  "approval_policy_binding.update": ["owner"],
};

function json<T>(value: string, fallback: T): T {
  const parsed = Result.try({ try: (): unknown => JSON.parse(value), catch: () => null });
  return Result.isSuccess(parsed) && parsed.value !== null ? (parsed.value as T) : fallback;
}

function platformError(error: unknown): UltraEasyError {
  return new UltraEasyError(
    "platform_unavailable",
    error instanceof Error ? error.message : "ultra-easy mock failed",
  );
}

export type MockUltraEasyDependencies = {
  db: D1DatabaseLike;
  downstream: McpDownstream;
  now: () => string;
  /** Base path of the mock Approval UI (deep links). */
  approvalBasePath: string;
};

export class MockUltraEasy implements UltraEasyClient {
  constructor(private readonly deps: MockUltraEasyDependencies) {}

  // ---------------------------------------------------------------------------
  // storage helpers (reject on D1 failure; converted by `guard`)
  // ---------------------------------------------------------------------------

  private first<T>(query: string, ...values: Array<string | number | null>) {
    return this.deps.db
      .prepare(query)
      .bind(...values)
      .first<T>();
  }

  private async all<T>(query: string, ...values: Array<string | number | null>) {
    return (
      await this.deps.db
        .prepare(query)
        .bind(...values)
        .all<T>()
    ).results;
  }

  private async run(query: string, ...values: Array<string | number | null>) {
    return (
      (
        await this.deps.db
          .prepare(query)
          .bind(...values)
          .run()
      ).meta?.changes ?? 0
    );
  }

  private guard<T>(
    operation: () => Result.ResultAsync<T, UltraEasyError>,
  ): Result.ResultAsync<T, UltraEasyError> {
    return Result.try({ try: operation, catch: platformError }).then((outer) =>
      Result.isFailure(outer) ? outer : outer.value,
    );
  }

  private async audit(
    organizationId: string,
    actionRequestId: string,
    runId: string | null,
    type: string,
    detail: string,
  ) {
    await this.run(
      `INSERT INTO mock_audit_events (organization_id, action_request_id, run_id, type, detail, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      organizationId,
      actionRequestId,
      runId,
      type,
      detail,
      this.deps.now(),
    );
  }

  private async principal(organizationId: string, id: string): Promise<PrincipalRef> {
    if (id === MAINTENANCE_AGENT.id) return MAINTENANCE_AGENT;
    const row = await this.first<{ display_name: string }>(
      "SELECT display_name FROM mock_principals WHERE organization_id = ? AND id = ?",
      organizationId,
      id,
    );
    return { id, displayName: row?.display_name ?? id };
  }

  private async roleOf(organizationId: string, principalId: string, spaceId: string) {
    const row = await this.first<{ role: SpaceRole }>(
      `SELECT role FROM mock_space_roles
       WHERE organization_id = ? AND principal_id = ? AND space_id = ?`,
      organizationId,
      principalId,
      spaceId,
    );
    return row?.role ?? null;
  }

  private async authorized(
    organizationId: string,
    authorityId: string,
    spaceId: string,
    actionType: string,
  ): Promise<boolean> {
    const role = await this.roleOf(organizationId, authorityId, spaceId);
    return role !== null && (REQUIRED_ROLES[actionType] ?? []).includes(role);
  }

  private async policyFor(organizationId: string, spaceId: string) {
    const row = await this.first<{ version: number; policy_json: string }>(
      "SELECT version, policy_json FROM mock_policy_bindings WHERE organization_id = ? AND space_id = ?",
      organizationId,
      spaceId,
    );
    return row
      ? {
          version: Number(row.version),
          policy: json<CompiledPolicy>(row.policy_json, DEFAULT_KNOWLEDGE_POLICY),
        }
      : { version: 0, policy: DEFAULT_KNOWLEDGE_POLICY };
  }

  private async loadRun(organizationId: string, runId: string): Promise<RunRecord | null> {
    const row = await this.first<RunRow>(
      "SELECT * FROM mock_workflow_runs WHERE organization_id = ? AND id = ?",
      organizationId,
      runId,
    );
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: RunRow): RunRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      actionRequestId: row.action_request_id,
      actionType: row.action_type,
      correlation: {
        spaceId: row.space_id,
        ...(row.page_id ? { pageId: row.page_id } : {}),
        ...(row.publication_snapshot_id
          ? { publicationSnapshotId: row.publication_snapshot_id }
          : {}),
      },
      status: row.status,
      state: json<RunState>(row.state_json, {
        nodes: [],
        childActions: [],
        humanInputs: [],
        failure: null,
      }),
      requestedBy: json<PrincipalRef>(row.requested_by_json, {
        id: "unknown",
        displayName: "unknown",
      }),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  }

  private async saveRun(run: RunRecord) {
    run.updatedAt = this.deps.now();
    await this.run(
      "UPDATE mock_workflow_runs SET status = ?, state_json = ?, updated_at = ? WHERE id = ?",
      run.status,
      JSON.stringify(run.state),
      run.updatedAt,
      run.id,
    );
    await this.run(
      "UPDATE mock_action_requests SET status = ?, updated_at = ? WHERE id = ?",
      run.status,
      run.updatedAt,
      run.actionRequestId,
    );
  }

  private async view(run: RunRecord): Promise<WorkflowRunView> {
    const tasks = await this.all<TaskRow>(
      `SELECT * FROM mock_approval_tasks WHERE run_id = ? ORDER BY created_at`,
      run.id,
    );
    const audit = await this.all<{
      at: string;
      type: string;
      action_request_id: string;
      detail: string;
    }>(
      "SELECT at, type, action_request_id, detail FROM mock_audit_events WHERE run_id = ? ORDER BY seq",
      run.id,
    );
    return {
      id: run.id,
      actionRequestId: run.actionRequestId,
      actionType: run.actionType,
      organizationId: run.organizationId,
      status: run.status,
      correlation: run.correlation,
      requestedBy: run.requestedBy,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      nodes: run.state.nodes,
      childActions: run.state.childActions.map(
        ({ resultData: _data, errorMessage: _message, ...child }) => child,
      ),
      approvals: tasks.map((task) => this.taskRef(task)),
      humanInputs: run.state.humanInputs,
      failure: run.state.failure,
      audit: audit.map((event): AuditEventRef => ({
        at: event.at,
        type: event.type,
        actionRequestId: event.action_request_id,
        detail: event.detail,
      })),
    };
  }

  private taskRef(task: TaskRow): ApprovalTaskRef {
    return {
      taskId: task.id,
      actionRequestId: task.action_request_id,
      actionType: task.action_type,
      status: task.status,
      candidateIds: json<string[]>(task.candidate_ids_json, []),
      url: this.approvalUrl(task.id),
    };
  }

  // ---------------------------------------------------------------------------
  // authorization relationships
  // ---------------------------------------------------------------------------

  listPrincipals(organizationId: string) {
    return this.guard(async () =>
      Result.succeed(
        (
          await this.all<{ id: string; display_name: string }>(
            "SELECT id, display_name FROM mock_principals WHERE organization_id = ? ORDER BY display_name",
            organizationId,
          )
        ).map((row) => ({ id: row.id, displayName: row.display_name })),
      ),
    );
  }

  spaceRoles(input: { organizationId: string; principalId: string }) {
    return this.guard(async () => {
      const rows = await this.all<{ space_id: string; role: SpaceRole }>(
        "SELECT space_id, role FROM mock_space_roles WHERE organization_id = ? AND principal_id = ?",
        input.organizationId,
        input.principalId,
      );
      return Result.succeed(new Map(rows.map((row) => [row.space_id, row.role])));
    });
  }

  spaceMembers(input: { organizationId: string; spaceId: string }) {
    return this.guard(async () => {
      const rows = await this.all<{
        principal_id: string;
        role: SpaceRole;
        display_name: string | null;
      }>(
        `SELECT r.principal_id, r.role, p.display_name FROM mock_space_roles r
         LEFT JOIN mock_principals p ON p.organization_id = r.organization_id AND p.id = r.principal_id
         WHERE r.organization_id = ? AND r.space_id = ?
         ORDER BY CASE r.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, p.display_name`,
        input.organizationId,
        input.spaceId,
      );
      return Result.succeed(
        rows.map((row) => ({
          principal: { id: row.principal_id, displayName: row.display_name ?? row.principal_id },
          role: row.role,
        })),
      );
    });
  }

  grantSpaceRole(input: {
    organizationId: string;
    principalId: string;
    spaceId: string;
    role: SpaceRole;
  }) {
    return this.guard(async () => {
      await this.run(
        `INSERT INTO mock_space_roles (organization_id, principal_id, space_id, role) VALUES (?, ?, ?, ?)
         ON CONFLICT (organization_id, principal_id, space_id) DO UPDATE SET role = excluded.role`,
        input.organizationId,
        input.principalId,
        input.spaceId,
        input.role,
      );
      return Result.succeed(undefined);
    });
  }

  /** Seeding helper for the demo directory (not part of the public port). */
  async upsertPrincipal(organizationId: string, principal: PrincipalRef) {
    await this.run(
      `INSERT INTO mock_principals (organization_id, id, display_name) VALUES (?, ?, ?)
       ON CONFLICT (organization_id, id) DO UPDATE SET display_name = excluded.display_name`,
      organizationId,
      principal.id,
      principal.displayName,
    );
  }

  // ---------------------------------------------------------------------------
  // ActionRequests / workflow runs
  // ---------------------------------------------------------------------------

  startAction(input: StartActionInput): Result.ResultAsync<StartActionResult, UltraEasyError> {
    return this.guard(async () => {
      const existing = await this.first<{ id: string }>(
        "SELECT id FROM mock_action_requests WHERE organization_id = ? AND idempotency_key = ?",
        input.organizationId,
        input.idempotencyKey,
      );
      if (existing) {
        const run = await this.first<RunRow>(
          "SELECT * FROM mock_workflow_runs WHERE action_request_id = ?",
          existing.id,
        );
        if (!run) return Result.fail(new UltraEasyError("invalid_state", "request has no run"));
        return Result.succeed({
          actionRequestId: existing.id,
          run: await this.view(this.toRecord(run)),
        });
      }
      const allowed = await this.authorized(
        input.organizationId,
        input.actor.id,
        input.correlation.spaceId,
        input.actionType,
      );
      if (!allowed) {
        return Result.fail(new UltraEasyError("forbidden", `${input.actionType} is not permitted`));
      }

      const now = this.deps.now();
      const actionRequestId = newId("ar");
      const runId = newId("run");
      await this.run(
        `INSERT INTO mock_action_requests (id, organization_id, parent_id, run_id, action_type,
           resource_type, resource_id, input_json, actor_json, authority_json, idempotency_key,
           status, result_json, error_code, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)`,
        actionRequestId,
        input.organizationId,
        runId,
        input.actionType,
        input.resource.type,
        input.resource.id,
        JSON.stringify(input.input),
        JSON.stringify(input.actor),
        JSON.stringify(input.actor),
        input.idempotencyKey,
        now,
        now,
      );
      const run: RunRecord = {
        id: runId,
        organizationId: input.organizationId,
        actionRequestId,
        actionType: input.actionType,
        correlation: input.correlation,
        status: "running",
        state: this.initialState(input),
        requestedBy: input.actor,
        startedAt: now,
        updatedAt: now,
      };
      await this.run(
        `INSERT INTO mock_workflow_runs (id, organization_id, action_request_id, action_type, space_id,
           page_id, publication_snapshot_id, status, state_json, requested_by_json, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
        run.id,
        run.organizationId,
        actionRequestId,
        input.actionType,
        input.correlation.spaceId,
        input.correlation.pageId ?? null,
        input.correlation.publicationSnapshotId ?? null,
        JSON.stringify(run.state),
        JSON.stringify(input.actor),
        now,
        now,
      );
      await this.audit(
        run.organizationId,
        actionRequestId,
        run.id,
        "action.received",
        `${input.actionType} by ${input.actor.id} (${correlationText(input.correlation)})`,
      );
      await this.audit(
        run.organizationId,
        actionRequestId,
        run.id,
        "authorization.allowed",
        input.actor.id,
      );
      await this.advance(run);
      return Result.succeed({ actionRequestId, run: await this.view(run) });
    });
  }

  private initialState(input: StartActionInput): RunState {
    const nodes = (definition: Array<[string, string]>): RunNode[] =>
      definition.map(([key, label]) => ({ key, label, status: "pending" }));
    const base = { childActions: [], humanInputs: [], failure: null };
    switch (input.actionType) {
      case "knowledge.publish_document":
        return {
          ...base,
          nodes: nodes(PUBLISH_NODES),
          publish: {
            snapshotId: text(input.input.publicationSnapshotId),
            pageId: input.correlation.pageId ?? "",
            pageOwnerId: null,
            visibility: null,
            sensitivity: null,
            publishChildId: null,
            reindexChildId: null,
            notifyChildId: null,
          },
        };
      case "knowledge.maintain_space":
        return {
          ...base,
          nodes: nodes(MAINTENANCE_NODES),
          maintenance: { spaceId: input.correlation.spaceId, items: [] },
        };
      default:
        return {
          ...base,
          nodes: [
            {
              key: "execute",
              label: SINGLE_ACTION_LABELS[input.actionType] ?? input.actionType,
              status: "pending",
            },
          ],
          single: {
            toolName: TOOL_FOR_ACTION[input.actionType] ?? input.actionType,
            input: input.input,
            pageOwnerId:
              typeof input.input.pageOwnerId === "string" ? input.input.pageOwnerId : null,
            childId: null,
          },
        };
    }
  }

  private node(run: RunRecord, key: string): RunNode {
    const found = run.state.nodes.find((node) => node.key === key);
    if (found) return found;
    const created: RunNode = { key, label: key, status: "pending" };
    run.state.nodes.push(created);
    return created;
  }

  private settle(run: RunRecord, status: NodeStatus, from: string) {
    let after = false;
    for (const node of run.state.nodes) {
      if (node.key === from) after = true;
      if (
        after &&
        (node.status === "pending" || node.status === "waiting" || node.status === "running")
      ) {
        node.status = status;
      }
    }
  }

  private async fail(
    run: RunRecord,
    nodeKey: string,
    code: string,
    message: string,
    status: RunStatus = "failed",
  ) {
    run.state.failure = { code, message, nodeKey };
    run.status = status;
    await this.audit(
      run.organizationId,
      run.actionRequestId,
      run.id,
      `workflow.${status}`,
      `${nodeKey}: ${code}`,
    );
  }

  /** Drives a run until it completes or reaches a durable wait. */
  private async advance(run: RunRecord) {
    if (run.state.publish) await this.advancePublish(run);
    else if (run.state.maintenance) await this.advanceMaintenance(run);
    else if (run.state.single) await this.advanceSingle(run);
    await this.saveRun(run);
  }

  private async callRead(run: RunRecord, toolName: string, args: Record<string, unknown>) {
    return this.deps.downstream.callTool({
      toolName,
      arguments: args,
      idempotencyKey: `${run.id}:${toolName}:${JSON.stringify(args)}`,
      actionRequestId: run.actionRequestId,
    });
  }

  private async advancePublish(run: RunRecord) {
    const publish = run.state.publish;
    if (!publish) return;
    const analyze = this.node(run, "analyze_metadata");
    if (analyze.status === "pending") {
      const loaded = await this.callRead(run, "knowledge.publication.get", {
        publicationSnapshotId: publish.snapshotId,
      });
      if (loaded.type !== "success") {
        analyze.status = "failed";
        analyze.errorCode = outcomeCode(loaded);
        this.settle(run, "cancelled", "related_pages");
        return this.fail(run, "analyze_metadata", outcomeCode(loaded), outcomeMessage(loaded));
      }
      const snapshot = record(loaded.data.snapshot);
      const revision = record(loaded.data.revision);
      const page = record(loaded.data.page);
      publish.pageOwnerId = typeof page.ownerId === "string" ? page.ownerId : null;
      // Trusted, immutable snapshot fields drive the policy (not LLM output).
      publish.visibility = typeof snapshot.visibility === "string" ? snapshot.visibility : null;
      publish.sensitivity = typeof snapshot.sensitivity === "string" ? snapshot.sensitivity : null;
      const analysis = analyzeMetadata({
        title: text(revision.title),
        body: text(revision.body),
        tags: Array.isArray(revision.tags) ? revision.tags.map(String) : [],
      });
      analyze.status = "succeeded";
      analyze.detail =
        (analysis.suggestedTags.length
          ? `Suggested tags: ${analysis.suggestedTags.join(", ")}. `
          : "") +
        (analysis.riskSignals.length
          ? `Risk signals: ${analysis.riskSignals.join(", ")}.`
          : "No risk signals.");
      await this.audit(
        run.organizationId,
        run.actionRequestId,
        run.id,
        "llm.completed",
        "metadata analysis (untrusted suggestion)",
      );
      const related = this.node(run, "related_pages");
      related.status = "succeeded";
      related.detail =
        Array.isArray(revision.tags) && revision.tags.length
          ? `Candidates by tags: ${revision.tags.map(String).join(", ")}`
          : "No tag-based candidates";
    }

    const approval = this.node(run, "publication_approval");
    const publishNode = this.node(run, "publish");
    if (!publish.publishChildId) {
      const child = await this.startChild(run, {
        actionType: "knowledge.revision.publish",
        input: { publicationSnapshotId: publish.snapshotId },
        policyInput: {
          visibility: publish.visibility ?? "",
          sensitivity: publish.sensitivity ?? "",
        },
        actor: run.requestedBy,
        pageOwnerId: publish.pageOwnerId,
        subjectPageId: publish.pageId,
      });
      publish.publishChildId = child.actionRequestId;
    }
    const child = this.child(run, publish.publishChildId);
    if (!child) return;
    switch (child.status) {
      case "waiting_approval":
        approval.status = "waiting";
        approval.detail = "Waiting for publication approval in ultra-easy";
        run.status = "waiting_approval";
        return;
      case "rejected":
        approval.status = "failed";
        approval.detail = "Rejected";
        this.settle(run, "cancelled", "publish");
        return this.fail(
          run,
          "publication_approval",
          "approval_rejected",
          "Publication was rejected",
          "rejected",
        );
      case "cancelled":
        approval.status = "cancelled";
        this.settle(run, "cancelled", "publish");
        run.status = "cancelled";
        return;
      case "failed":
        if (child.approvalTaskId) approval.status = "succeeded";
        else if (approval.status === "pending")
          approval.status = child.errorCode === "authorization_denied" ? "cancelled" : "skipped";
        publishNode.status = "failed";
        publishNode.errorCode = child.errorCode;
        publishNode.detail = child.errorMessage;
        this.settle(run, "cancelled", "reindex");
        return this.fail(
          run,
          "publish",
          child.errorCode ?? "publish_failed",
          child.errorMessage ?? "Publish failed",
        );
      case "succeeded":
        if (child.approvalTaskId) {
          approval.status = "succeeded";
          approval.detail = "Approved";
        } else if (approval.status === "pending") {
          approval.status = "skipped";
          approval.detail = "Not required by policy";
        }
        publishNode.status = "succeeded";
        break;
      default:
        return;
    }

    // Post-publish effects: independent child actions; failures never roll back.
    for (const [key, actionType, field] of [
      ["reindex", "knowledge.search.reindex", "reindexChildId"],
      ["notify", "knowledge.watchers.notify", "notifyChildId"],
    ] as const) {
      const node = this.node(run, key);
      if (!publish[field]) {
        const effect = await this.startChild(run, {
          actionType,
          input: { publicationSnapshotId: publish.snapshotId },
          policyInput: {},
          actor: run.requestedBy,
          pageOwnerId: publish.pageOwnerId,
          subjectPageId: publish.pageId,
        });
        publish[field] = effect.actionRequestId;
      }
      const effect = this.child(run, publish[field]);
      node.status = effect?.status === "succeeded" ? "succeeded" : "failed";
      node.errorCode = effect?.errorCode;
      node.detail = effect?.errorMessage;
    }
    const failed = run.state.nodes.find(
      (node) => (node.key === "reindex" || node.key === "notify") && node.status === "failed",
    );
    if (failed) {
      const effect = this.child(
        run,
        failed.key === "reindex" ? publish.reindexChildId : publish.notifyChildId,
      );
      return this.fail(
        run,
        failed.key,
        effect?.errorCode ?? "effect_failed",
        effect?.errorMessage ?? "Post-publish effect failed",
      );
    }
    run.status = "succeeded";
    await this.audit(
      run.organizationId,
      run.actionRequestId,
      run.id,
      "workflow.succeeded",
      `published ${publish.snapshotId}`,
    );
  }

  private async advanceSingle(run: RunRecord) {
    const single = run.state.single;
    if (!single) return;
    const node = this.node(run, "execute");
    if (!single.childId) {
      const child = await this.startChild(run, {
        actionType: SINGLE_CHILD_ACTION[run.actionType] ?? run.actionType,
        input: single.input,
        policyInput: {},
        actor: run.requestedBy,
        pageOwnerId: single.pageOwnerId,
        subjectPageId: run.correlation.pageId,
      });
      single.childId = child.actionRequestId;
    }
    const child = this.child(run, single.childId);
    if (!child) return;
    switch (child.status) {
      case "waiting_approval":
        node.status = "waiting";
        node.detail = "Waiting for approval in ultra-easy";
        run.status = "waiting_approval";
        return;
      case "succeeded":
        node.status = "succeeded";
        node.detail = undefined;
        run.status = "succeeded";
        return;
      case "rejected":
        node.status = "failed";
        return this.fail(run, "execute", "approval_rejected", "Request was rejected", "rejected");
      case "cancelled":
        node.status = "cancelled";
        run.status = "cancelled";
        return;
      case "failed":
        node.status = "failed";
        node.errorCode = child.errorCode;
        return this.fail(
          run,
          "execute",
          child.errorCode ?? "action_failed",
          child.errorMessage ?? "Action failed",
        );
      default:
        return;
    }
  }

  private async advanceMaintenance(run: RunRecord) {
    const maintenance = run.state.maintenance;
    if (!maintenance) return;
    const listNode = this.node(run, "list_stale");
    if (listNode.status === "pending") {
      const listed = await this.callRead(run, "knowledge.pages.list_stale", {
        spaceId: maintenance.spaceId,
      });
      if (listed.type !== "success") {
        listNode.status = "failed";
        this.settle(run, "cancelled", "analyze");
        return this.fail(run, "list_stale", outcomeCode(listed), outcomeMessage(listed));
      }
      const pages = Array.isArray(listed.data.pages) ? listed.data.pages.map(record) : [];
      maintenance.items = pages.map((page) => ({
        pageId: text(page.pageId),
        title: text(page.pageId),
        ownerId: text(page.ownerId),
        verdict: null,
        analysis: "",
        status: "analyze",
        decision: null,
        resolution: null,
        childActionRequestId: null,
      }));
      listNode.status = "succeeded";
      listNode.detail = `${maintenance.items.length} stale page(s)`;
    }

    // ForEach page: LLM freshness analysis on the *published* revision only.
    const analyzeNode = this.node(run, "analyze");
    for (const item of maintenance.items.filter((entry) => entry.status === "analyze")) {
      const page = await this.callRead(run, "knowledge.page.get_published", {
        pageId: item.pageId,
      });
      if (page.type !== "success") {
        item.status = "failed";
        item.resolution = outcomeCode(page);
        continue;
      }
      item.title = text(page.data.title) || item.pageId;
      const assessed = assessFreshness({
        title: item.title,
        body: text(page.data.body),
        publishedAt: typeof page.data.publishedAt === "string" ? page.data.publishedAt : null,
        lastReviewedAt:
          typeof page.data.lastReviewedAt === "string" ? page.data.lastReviewedAt : null,
        now: this.deps.now(),
      });
      item.verdict = assessed.verdict;
      item.analysis = assessed.analysis;
      item.status = "branch";
    }
    if (analyzeNode.status === "pending") {
      analyzeNode.status = "succeeded";
      const count = (verdict: FreshnessVerdict) =>
        maintenance.items.filter((item) => item.verdict === verdict).length;
      analyzeNode.detail = maintenance.items.length
        ? `${count("likely_current")} likely current · ${count("needs_review")} need review · ${count("archive_candidate")} archive candidate(s)`
        : "Nothing to analyze";
    }

    // Branch per page.
    for (const item of maintenance.items) {
      if (item.status === "branch") {
        if (item.verdict === "needs_review") {
          run.state.humanInputs.push({
            key: `review:${item.pageId}`,
            subject: { pageId: item.pageId, title: item.title },
            prompt: "This page may be stale. Is it still valid?",
            analysis: item.analysis,
            assigneeId: item.ownerId,
            options: ["still_valid", "update_needed", "archive_candidate"],
            status: "waiting",
          });
          item.status = "waiting_input";
          await this.audit(
            run.organizationId,
            run.actionRequestId,
            run.id,
            "human_input.requested",
            `${item.pageId} -> ${item.ownerId}`,
          );
        } else {
          item.decision =
            item.verdict === "archive_candidate" ? "archive_candidate" : "still_valid";
          await this.applyMaintenanceDecision(run, item);
        }
      } else if (item.status === "waiting_input") {
        const input = run.state.humanInputs.find((entry) => entry.key === `review:${item.pageId}`);
        if (input?.status === "answered" && input.answer) {
          item.decision = input.answer;
          await this.applyMaintenanceDecision(run, item);
        }
      } else if (item.status === "waiting_approval") {
        this.resolveMaintenanceChild(run, item);
      }
    }

    const reviewNode = this.node(run, "owner_review");
    const applyNode = this.node(run, "apply");
    const waitingInput = maintenance.items.filter((item) => item.status === "waiting_input").length;
    const waitingApproval = maintenance.items.filter(
      (item) => item.status === "waiting_approval",
    ).length;
    const failed = maintenance.items.filter((item) => item.status === "failed").length;
    const reviewed = run.state.humanInputs.length;
    reviewNode.status = waitingInput ? "waiting" : reviewed ? "succeeded" : "skipped";
    reviewNode.detail = waitingInput
      ? `${waitingInput} page(s) waiting for owner input`
      : reviewed
        ? `${reviewed} page(s) reviewed by owners`
        : "No owner review needed";
    applyNode.status = waitingApproval
      ? "waiting"
      : waitingInput
        ? "pending"
        : failed
          ? "failed"
          : "succeeded";
    applyNode.detail = maintenance.items
      .filter((item) => item.resolution)
      .map((item) => `${item.title}: ${item.resolution}`)
      .join(" · ");
    if (waitingInput) run.status = "waiting_input";
    else if (waitingApproval) run.status = "waiting_approval";
    else if (failed)
      await this.fail(
        run,
        "apply",
        "maintenance_item_failed",
        `${failed} page(s) could not be processed`,
      );
    else {
      run.status = "succeeded";
      await this.audit(
        run.organizationId,
        run.actionRequestId,
        run.id,
        "workflow.succeeded",
        `${maintenance.items.length} page(s) processed`,
      );
    }
  }

  private async applyMaintenanceDecision(run: RunRecord, item: MaintenanceItem) {
    const archive = item.decision === "archive_candidate";
    const child = await this.startChild(run, {
      actionType: archive ? "knowledge.page.archive" : "knowledge.page.mark_reviewed",
      input: archive
        ? { pageId: item.pageId }
        : {
            pageId: item.pageId,
            outcome: item.decision === "update_needed" ? "update_needed" : "reviewed",
          },
      policyInput: {},
      // Side effects of the maintenance workflow are requested by the agent on
      // behalf of the space owner who started it (authority).
      actor: MAINTENANCE_AGENT,
      pageOwnerId: item.ownerId,
      subjectPageId: item.pageId,
    });
    item.childActionRequestId = child.actionRequestId;
    item.status = "waiting_approval";
    this.resolveMaintenanceChild(run, item);
  }

  private resolveMaintenanceChild(run: RunRecord, item: MaintenanceItem) {
    const child = this.child(run, item.childActionRequestId);
    if (!child) return;
    const archive = child.actionType === "knowledge.page.archive";
    switch (child.status) {
      case "waiting_approval":
        item.status = "waiting_approval";
        item.resolution = "archive waiting for page owner approval";
        return;
      case "succeeded":
        item.status = "done";
        item.resolution = archive
          ? "archived"
          : item.decision === "update_needed"
            ? "update needed"
            : "marked reviewed";
        return;
      case "rejected":
      case "cancelled":
        item.status = "done";
        item.resolution = "archive rejected";
        return;
      case "failed":
        item.status = "failed";
        item.resolution = child.errorCode ?? "failed";
        return;
      default:
        return;
    }
  }

  private child(run: RunRecord, id: string | null): ChildState | null {
    return run.state.childActions.find((child) => child.actionRequestId === id) ?? null;
  }

  /**
   * Child ActionRequest: Authorization -> Policy -> (Approval | execution).
   * A parent approval never bypasses the child's own checks.
   */
  private async startChild(
    run: RunRecord,
    spec: {
      actionType: string;
      input: Record<string, unknown>;
      policyInput: Record<string, string>;
      actor: PrincipalRef;
      pageOwnerId: string | null;
      subjectPageId?: string;
    },
  ): Promise<ChildState> {
    const now = this.deps.now();
    const id = newId("ar");
    const child: ChildState = {
      actionRequestId: id,
      actionType: spec.actionType,
      status: "pending",
      ...(spec.subjectPageId ? { subjectPageId: spec.subjectPageId } : {}),
    };
    run.state.childActions.push(child);
    await this.run(
      `INSERT INTO mock_action_requests (id, organization_id, parent_id, run_id, action_type,
         resource_type, resource_id, input_json, actor_json, authority_json, idempotency_key, status,
         result_json, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'knowledge_page', ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      id,
      run.organizationId,
      run.actionRequestId,
      run.id,
      spec.actionType,
      spec.subjectPageId ?? run.correlation.spaceId,
      JSON.stringify({ ...spec.input, ...spec.policyInput, pageOwnerId: spec.pageOwnerId }),
      JSON.stringify(spec.actor),
      JSON.stringify(run.requestedBy),
      id,
      now,
      now,
    );
    await this.audit(
      run.organizationId,
      id,
      run.id,
      "action.received",
      `${spec.actionType} (child of ${run.actionRequestId}) ${JSON.stringify(spec.input)}`,
    );

    if (
      !(await this.authorized(
        run.organizationId,
        run.requestedBy.id,
        run.correlation.spaceId,
        spec.actionType,
      ))
    ) {
      await this.finishChild(run, child, {
        type: "tool_error",
        code: "authorization_denied",
        message: "Authorization denied",
        retriable: false,
        data: {},
      });
      return child;
    }
    await this.audit(run.organizationId, id, run.id, "authorization.allowed", run.requestedBy.id);

    const { policy } = await this.policyFor(run.organizationId, run.correlation.spaceId);
    const rule = matchRule({
      policy,
      actionType: spec.actionType,
      actionInput: spec.policyInput,
      actorId: spec.actor.id,
      pageOwnerId: spec.pageOwnerId,
    });
    if (rule) {
      const candidates =
        rule.approvers === "page_owner"
          ? spec.pageOwnerId
            ? [spec.pageOwnerId]
            : []
          : (
              await this.all<{ principal_id: string }>(
                `SELECT principal_id FROM mock_space_roles
                 WHERE organization_id = ? AND space_id = ? AND role = 'owner' ORDER BY principal_id`,
                run.organizationId,
                run.correlation.spaceId,
              )
            ).map((row) => row.principal_id);
      // Self-approval is not allowed: whoever directly requested the action
      // (a user, or the agent acting for one) cannot approve it.
      const eligible = candidates.filter((candidate) => candidate !== spec.actor.id);
      if (eligible.length === 0) {
        await this.finishChild(run, child, {
          type: "tool_error",
          code: "no_eligible_approver",
          message: `Policy rule "${rule.key}" requires approval but no other eligible approver exists`,
          retriable: false,
          data: {},
        });
        return child;
      }
      const taskId = newId("apt");
      await this.run(
        `INSERT INTO mock_approval_tasks (id, organization_id, action_request_id, run_id, action_type,
           summary_json, candidate_ids_json, requested_by, status, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
        taskId,
        run.organizationId,
        id,
        run.id,
        spec.actionType,
        JSON.stringify({
          rule: rule.key,
          input: spec.input,
          ...spec.policyInput,
          spaceId: run.correlation.spaceId,
          pageId: spec.subjectPageId ?? null,
        }),
        JSON.stringify(eligible),
        run.requestedBy.id,
        now,
      );
      child.status = "waiting_approval";
      child.approvalTaskId = taskId;
      await this.run(
        "UPDATE mock_action_requests SET status = 'waiting_approval' WHERE id = ?",
        id,
      );
      await this.audit(
        run.organizationId,
        id,
        run.id,
        "approval.requested",
        `rule ${rule.key}; candidates ${eligible.join(", ")}`,
      );
      return child;
    }
    await this.executeChild(run, child);
    return child;
  }

  private async executeChild(run: RunRecord, child: ChildState) {
    const row = await this.first<{ input_json: string }>(
      "SELECT input_json FROM mock_action_requests WHERE id = ?",
      child.actionRequestId,
    );
    const input = json<Record<string, unknown>>(row?.input_json ?? "{}", {});
    const toolName = TOOL_FOR_ACTION[child.actionType] ?? child.actionType;
    const toolArgs = toolArguments(toolName, input);
    const outcome = await this.deps.downstream.callTool({
      toolName,
      arguments: toolArgs,
      idempotencyKey: child.actionRequestId,
      actionRequestId: child.actionRequestId,
    });
    await this.finishChild(run, child, outcome);
  }

  private async finishChild(run: RunRecord, child: ChildState, outcome: DownstreamOutcome) {
    if (outcome.type === "success") {
      child.status = "succeeded";
      child.resultData = outcome.data;
      child.errorCode = undefined;
    } else {
      child.status = "failed";
      child.errorCode = outcomeCode(outcome);
      child.errorMessage = outcomeMessage(outcome);
    }
    await this.run(
      "UPDATE mock_action_requests SET status = ?, result_json = ?, error_code = ?, updated_at = ? WHERE id = ?",
      child.status,
      JSON.stringify(
        outcome.type === "success"
          ? outcome.data
          : { code: child.errorCode, message: child.errorMessage },
      ),
      child.errorCode ?? null,
      this.deps.now(),
      child.actionRequestId,
    );
    await this.audit(
      run.organizationId,
      child.actionRequestId,
      run.id,
      outcome.type === "success" ? "execution.succeeded" : "execution.failed",
      outcome.type === "success"
        ? `${child.actionType} ${JSON.stringify(outcome.data)}`
        : `${child.actionType} ${child.errorCode}`,
    );
  }

  cancelAction(input: { organizationId: string; actionRequestId: string; actor: PrincipalRef }) {
    return this.guard(async () => {
      const row = await this.first<RunRow>(
        "SELECT * FROM mock_workflow_runs WHERE organization_id = ? AND action_request_id = ?",
        input.organizationId,
        input.actionRequestId,
      );
      if (!row) return Result.fail(new UltraEasyError("not_found", "unknown request"));
      const run = this.toRecord(row);
      const role = await this.roleOf(run.organizationId, input.actor.id, run.correlation.spaceId);
      if (run.requestedBy.id !== input.actor.id && role !== "owner") {
        return Result.fail(
          new UltraEasyError("forbidden", "only the requester or a space owner can cancel"),
        );
      }
      if (run.status !== "waiting_approval" && run.status !== "waiting_input") {
        return Result.fail(
          new UltraEasyError("invalid_state", "only waiting requests can be cancelled"),
        );
      }
      for (const child of run.state.childActions.filter(
        (entry) => entry.status === "waiting_approval",
      )) {
        child.status = "cancelled";
        await this.run(
          "UPDATE mock_approval_tasks SET status = 'cancelled' WHERE action_request_id = ? AND status = 'pending'",
          child.actionRequestId,
        );
        await this.run(
          "UPDATE mock_action_requests SET status = 'cancelled' WHERE id = ?",
          child.actionRequestId,
        );
      }
      this.settle(run, "cancelled", run.state.nodes[0]?.key ?? "");
      run.status = "cancelled";
      run.state.failure = null;
      await this.audit(
        run.organizationId,
        run.actionRequestId,
        run.id,
        "workflow.cancelled",
        `by ${input.actor.id}`,
      );
      await this.saveRun(run);
      return Result.succeed(await this.view(run));
    });
  }

  getRun(input: { organizationId: string; runId: string }) {
    return this.guard(async () => {
      const run = await this.loadRun(input.organizationId, input.runId);
      return Result.succeed(run ? await this.view(run) : null);
    });
  }

  findRunByActionRequest(input: { organizationId: string; actionRequestId: string }) {
    return this.guard(async () => {
      const row = await this.first<RunRow>(
        "SELECT * FROM mock_workflow_runs WHERE organization_id = ? AND action_request_id = ?",
        input.organizationId,
        input.actionRequestId,
      );
      return Result.succeed(row ? await this.view(this.toRecord(row)) : null);
    });
  }

  listRuns(input: { organizationId: string; spaceIds: readonly string[]; limit: number }) {
    return this.guard(async () => {
      const rows = await this.all<RunRow>(
        `SELECT * FROM mock_workflow_runs
         WHERE organization_id = ? AND space_id IN (SELECT value FROM json_each(?))
         ORDER BY updated_at DESC LIMIT ?`,
        input.organizationId,
        JSON.stringify(input.spaceIds),
        input.limit,
      );
      const views: WorkflowRunView[] = [];
      for (const row of rows) views.push(await this.view(this.toRecord(row)));
      return Result.succeed(views);
    });
  }

  submitHumanInput(input: {
    organizationId: string;
    runId: string;
    inputKey: string;
    answer: string;
    actor: PrincipalRef;
  }) {
    return this.guard(async () => {
      const run = await this.loadRun(input.organizationId, input.runId);
      if (!run) return Result.fail(new UltraEasyError("not_found", "unknown run"));
      const request = run.state.humanInputs.find((entry) => entry.key === input.inputKey);
      if (!request) return Result.fail(new UltraEasyError("not_found", "unknown input"));
      if (request.assigneeId !== input.actor.id) {
        return Result.fail(
          new UltraEasyError("forbidden", "this input is assigned to someone else"),
        );
      }
      if (request.status !== "waiting") {
        return Result.fail(new UltraEasyError("invalid_state", "input was already answered"));
      }
      if (!request.options.includes(input.answer)) {
        return Result.fail(new UltraEasyError("invalid_request", "unknown option"));
      }
      request.status = "answered";
      request.answer = input.answer;
      request.answeredBy = input.actor.id;
      await this.audit(
        run.organizationId,
        run.actionRequestId,
        run.id,
        "human_input.answered",
        `${input.inputKey}: ${input.answer} by ${input.actor.id}`,
      );
      await this.advance(run);
      return Result.succeed(await this.view(run));
    });
  }

  // ---------------------------------------------------------------------------
  // approvals (backend of the mock ultra-easy Approval UI)
  // ---------------------------------------------------------------------------

  getApprovalTask(input: { organizationId: string; taskId: string }) {
    return this.guard(async () => {
      const task = await this.first<TaskRow>(
        "SELECT * FROM mock_approval_tasks WHERE organization_id = ? AND id = ?",
        input.organizationId,
        input.taskId,
      );
      if (!task) return Result.succeed(null);
      const candidateIds = json<string[]>(task.candidate_ids_json, []);
      const candidates: PrincipalRef[] = [];
      for (const id of candidateIds)
        candidates.push(await this.principal(task.organization_id, id));
      const view: ApprovalTaskView = {
        ...this.taskRef(task),
        organizationId: task.organization_id,
        runId: task.run_id,
        requestedBy: await this.principal(task.organization_id, task.requested_by),
        candidates,
        summary: json<Record<string, unknown>>(task.summary_json, {}),
        decidedBy: task.decided_by
          ? await this.principal(task.organization_id, task.decided_by)
          : null,
        decidedAt: task.decided_at,
        createdAt: task.created_at,
      };
      return Result.succeed(view);
    });
  }

  decideApproval(input: {
    organizationId: string;
    taskId: string;
    decision: "approve" | "reject";
    actor: PrincipalRef;
  }) {
    return this.guard(async () => {
      const task = await this.first<TaskRow>(
        "SELECT * FROM mock_approval_tasks WHERE organization_id = ? AND id = ?",
        input.organizationId,
        input.taskId,
      );
      if (!task) return Result.fail(new UltraEasyError("not_found", "unknown approval task"));
      if (!json<string[]>(task.candidate_ids_json, []).includes(input.actor.id)) {
        return Result.fail(new UltraEasyError("forbidden", "you are not an approver of this task"));
      }
      const status = input.decision === "approve" ? "approved" : "rejected";
      const changed = await this.run(
        `UPDATE mock_approval_tasks SET status = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
        status,
        input.actor.id,
        this.deps.now(),
        task.id,
      );
      if (changed === 0)
        return Result.fail(new UltraEasyError("invalid_state", "task is no longer pending"));
      await this.audit(
        task.organization_id,
        task.action_request_id,
        task.run_id,
        `approval.${status}`,
        `by ${input.actor.id}`,
      );

      if (task.action_type === "approval_policy_binding.update") {
        await this.applyPolicyDecision(task, status);
        return Result.succeed(undefined);
      }
      const run = task.run_id ? await this.loadRun(task.organization_id, task.run_id) : null;
      const child = run?.state.childActions.find(
        (entry) => entry.actionRequestId === task.action_request_id,
      );
      if (!run || !child)
        return Result.fail(new UltraEasyError("invalid_state", "task has no run"));
      if (status === "rejected") {
        child.status = "rejected";
        await this.run(
          "UPDATE mock_action_requests SET status = 'rejected' WHERE id = ?",
          child.actionRequestId,
        );
      } else if (
        await this.authorized(
          run.organizationId,
          run.requestedBy.id,
          run.correlation.spaceId,
          child.actionType,
        )
      ) {
        // Re-Authorization right before execution (roles may have changed while waiting).
        await this.audit(
          run.organizationId,
          child.actionRequestId,
          run.id,
          "reauthorization.allowed",
          run.requestedBy.id,
        );
        await this.executeChild(run, child);
      } else {
        await this.finishChild(run, child, {
          type: "tool_error",
          code: "reauthorization_denied",
          message: "Permission changed while waiting for approval",
          retriable: false,
          data: {},
        });
      }
      await this.advance(run);
      return Result.succeed(undefined);
    });
  }

  // ---------------------------------------------------------------------------
  // governed policy bindings
  // ---------------------------------------------------------------------------

  getPolicyBinding(input: { organizationId: string; spaceId: string }) {
    return this.guard(async () =>
      Result.succeed(await this.policyView(input.organizationId, input.spaceId)),
    );
  }

  private async policyView(organizationId: string, spaceId: string): Promise<PolicyBindingView> {
    const current = await this.policyFor(organizationId, spaceId);
    const pending = await this.first<{ id: string; input_json: string; task_id: string | null }>(
      `SELECT a.id, a.input_json, t.id AS task_id FROM mock_action_requests a
       LEFT JOIN mock_approval_tasks t ON t.action_request_id = a.id AND t.status = 'pending'
       WHERE a.organization_id = ? AND a.action_type = 'approval_policy_binding.update'
         AND a.resource_id = ? AND a.status = 'waiting_approval'
       ORDER BY a.created_at DESC LIMIT 1`,
      organizationId,
      spaceId,
    );
    return {
      spaceId,
      version: current.version,
      policy: current.policy,
      pendingChange:
        pending && pending.task_id
          ? {
              actionRequestId: pending.id,
              approvalUrl: this.approvalUrl(pending.task_id),
              policy: json<CompiledPolicy>(pending.input_json, { rules: [] }),
            }
          : null,
    };
  }

  proposePolicyBinding(input: {
    organizationId: string;
    spaceId: string;
    policy: CompiledPolicy;
    actor: PrincipalRef;
  }) {
    return this.guard(async () => {
      if (
        !(await this.authorized(
          input.organizationId,
          input.actor.id,
          input.spaceId,
          "approval_policy_binding.update",
        ))
      ) {
        return Result.fail(
          new UltraEasyError("forbidden", "only space owners can change approval rules"),
        );
      }
      const now = this.deps.now();
      // A newer proposal supersedes a pending one.
      await this.run(
        `UPDATE mock_approval_tasks SET status = 'cancelled' WHERE status = 'pending' AND action_request_id IN (
           SELECT id FROM mock_action_requests WHERE organization_id = ? AND resource_id = ?
             AND action_type = 'approval_policy_binding.update' AND status = 'waiting_approval')`,
        input.organizationId,
        input.spaceId,
      );
      await this.run(
        `UPDATE mock_action_requests SET status = 'cancelled' WHERE organization_id = ? AND resource_id = ?
           AND action_type = 'approval_policy_binding.update' AND status = 'waiting_approval'`,
        input.organizationId,
        input.spaceId,
      );
      const id = newId("ar");
      const owners = (
        await this.all<{ principal_id: string }>(
          `SELECT principal_id FROM mock_space_roles WHERE organization_id = ? AND space_id = ? AND role = 'owner'`,
          input.organizationId,
          input.spaceId,
        )
      )
        .map((row) => row.principal_id)
        .filter((owner) => owner !== input.actor.id);
      await this.run(
        `INSERT INTO mock_action_requests (id, organization_id, parent_id, run_id, action_type,
           resource_type, resource_id, input_json, actor_json, authority_json, idempotency_key, status,
           result_json, error_code, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'approval_policy_binding.update', 'approval_policy_binding', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        id,
        input.organizationId,
        input.spaceId,
        JSON.stringify(input.policy),
        JSON.stringify(input.actor),
        JSON.stringify(input.actor),
        id,
        owners.length ? "waiting_approval" : "succeeded",
        now,
        now,
      );
      await this.audit(
        input.organizationId,
        id,
        null,
        "action.received",
        `approval_policy_binding.update ${input.spaceId}`,
      );
      if (owners.length === 0) {
        // Sole owner: meta-approval not required by the governance preset.
        await this.writePolicy(input.organizationId, input.spaceId, input.policy);
      } else {
        await this.run(
          `INSERT INTO mock_approval_tasks (id, organization_id, action_request_id, run_id, action_type,
             summary_json, candidate_ids_json, requested_by, status, decided_by, decided_at, created_at)
           VALUES (?, ?, ?, NULL, 'approval_policy_binding.update', ?, ?, ?, 'pending', NULL, NULL, ?)`,
          newId("apt"),
          input.organizationId,
          id,
          JSON.stringify({ spaceId: input.spaceId, policy: input.policy }),
          JSON.stringify(owners),
          input.actor.id,
          now,
        );
        await this.audit(
          input.organizationId,
          id,
          null,
          "approval.requested",
          `meta-approval by ${owners.join(", ")}`,
        );
      }
      return Result.succeed(await this.policyView(input.organizationId, input.spaceId));
    });
  }

  private async applyPolicyDecision(task: TaskRow, status: "approved" | "rejected") {
    const request = await this.first<{ resource_id: string; input_json: string }>(
      "SELECT resource_id, input_json FROM mock_action_requests WHERE id = ?",
      task.action_request_id,
    );
    await this.run(
      "UPDATE mock_action_requests SET status = ?, updated_at = ? WHERE id = ?",
      status === "approved" ? "succeeded" : "rejected",
      this.deps.now(),
      task.action_request_id,
    );
    if (status === "approved" && request) {
      await this.writePolicy(
        task.organization_id,
        request.resource_id,
        json<CompiledPolicy>(request.input_json, DEFAULT_KNOWLEDGE_POLICY),
      );
    }
  }

  private async writePolicy(organizationId: string, spaceId: string, policy: CompiledPolicy) {
    await this.run(
      `INSERT INTO mock_policy_bindings (organization_id, space_id, version, policy_json, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (organization_id, space_id) DO UPDATE SET version = mock_policy_bindings.version + 1,
         policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      organizationId,
      spaceId,
      JSON.stringify(policy),
      this.deps.now(),
    );
  }

  approvalUrl(taskId: string): string {
    return `${this.deps.approvalBasePath}/${encodeURIComponent(taskId)}`;
  }

  adminPolicyUrl(spaceId: string): string {
    return `/mock/ultra-easy/policies?space=${encodeURIComponent(spaceId)}`;
  }
}

type NodeStatus = RunNode["status"];

const SINGLE_ACTION_LABELS: Record<string, string> = {
  "knowledge.search.reindex": "Retry search index",
  "knowledge.watchers.notify": "Retry watcher notification",
  "knowledge.page.archive": "Archive page",
};

/** Single-action requests run one child ActionRequest of the same type. */
const SINGLE_CHILD_ACTION: Record<string, string> = {
  "knowledge.search.reindex": "knowledge.search.reindex",
  "knowledge.watchers.notify": "knowledge.watchers.notify",
  "knowledge.page.archive": "knowledge.page.archive",
};

function toolArguments(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case "knowledge.page.archive":
      return { pageId: input.pageId };
    case "knowledge.page.mark_reviewed":
      return { pageId: input.pageId, outcome: input.outcome };
    default:
      return { publicationSnapshotId: input.publicationSnapshotId };
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function outcomeCode(outcome: DownstreamOutcome): string {
  return outcome.type === "success" ? "ok" : outcome.code;
}

function outcomeMessage(outcome: DownstreamOutcome): string {
  return outcome.type === "success" ? "" : outcome.message;
}

function correlationText(correlation: ActionCorrelation): string {
  return [
    `space=${correlation.spaceId}`,
    correlation.pageId ? `page=${correlation.pageId}` : null,
    correlation.publicationSnapshotId ? `snapshot=${correlation.publicationSnapshotId}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
