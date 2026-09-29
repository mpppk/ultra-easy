import { Result } from "@praha/byethrow";

import { decodeUriComponent, parseBrand } from "@app/approval-core";
import type { ActionRequestId } from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  listPublishedActionDefinitions,
} from "@app/approval-d1";
import {
  DELEGATION_FIELD_NAMESPACES,
  WORKFLOW_FIELD_NAMESPACES,
  describeFieldCatalog,
} from "@app/expression-core";
import type { JsonObject } from "@app/expression-core";
import { WORKFLOW_EXECUTOR_KEY, workflowDefinitionIdOfActionKey } from "@app/workflow-application";
import {
  parseWorkflowDefinition,
  parseWorkflowId,
  validateWorkflowDefinition,
} from "@app/workflow-core";
import type { WorkflowDefinitionId, WorkflowRunId } from "@app/workflow-core";
import type { WorkflowPlatform } from "./platform.ts";

import type { OrganizationId, UserPrincipalRef } from "@app/approval-core";
import type { CapabilityPolicy } from "@app/workflow-application";

export type WorkflowStudioOptions = {
  prefix: string;
  env: { DB: D1Database; AI?: unknown };
  platform: WorkflowPlatform;
  organizationId: OrganizationId;
  actor: UserPrincipalRef;
  capabilityPolicy: CapabilityPolicy;
  llmModel: string;
  /** Preview-only fixture initialization. Production leaves this unset. */
  bootstrap?: () => Promise<Response>;
  /** Preview-only direct approval decision. Production uses the governed API. */
  decide?: (actionRequestId: ActionRequestId, input: Record<string, unknown>) => Promise<Response>;
};

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function problem(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: code, message, ...extra }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);
  return isRecord(parsed) ? parsed : {};
}

function now(): string {
  return new Date().toISOString();
}

function definitionId(raw: string): WorkflowDefinitionId | null {
  const parsed = parseWorkflowId("WorkflowDefinitionId", raw);
  return Result.isSuccess(parsed) ? parsed.value : null;
}

function runId(raw: string): WorkflowRunId | null {
  const parsed = parseWorkflowId("WorkflowRunId", raw);
  return Result.isSuccess(parsed) ? parsed.value : null;
}

function actionRequestId(raw: string): ActionRequestId | null {
  const parsed = parseBrand("ActionRequestId", raw);
  return Result.isSuccess(parsed) ? parsed.value : null;
}

async function catalogView(options: WorkflowStudioOptions) {
  const { env, platform, organizationId } = options;
  const definitions = await listPublishedActionDefinitions(env.DB, organizationId);
  if (Result.isFailure(definitions)) return definitions;
  const bindings = await platform.repositories.bindings.list({ organizationId: organizationId });
  if (Result.isFailure(bindings)) return Result.fail(bindings.error);
  const workflowFields = describeFieldCatalog(WORKFLOW_FIELD_NAMESPACES, []);
  const delegationFields = describeFieldCatalog(DELEGATION_FIELD_NAMESPACES, []);
  return Result.succeed({
    actions: definitions.value.map((definition) => {
      const composite = String(definition.executorKey) === String(WORKFLOW_EXECUTOR_KEY);
      const binding = composite
        ? bindings.value.find(
            (candidate) =>
              String(candidate.actionDefinitionKey) === String(definition.key) &&
              candidate.actionDefinitionVersion === definition.version,
          )
        : undefined;
      return {
        actionType: String(definition.actionType),
        kind: composite ? "composite" : "primitive",
        definitionKey: String(definition.key),
        version: definition.version,
        ...(binding
          ? {
              workflow: {
                definitionId: String(binding.workflowDefinitionId),
                version: binding.workflowVersion,
              },
            }
          : composite
            ? { workflow: { definitionId: workflowDefinitionIdOfActionKey(definition.key) } }
            : {}),
      };
    }),
    fields: {
      workflow: Result.isSuccess(workflowFields) ? workflowFields.value : null,
      delegation: Result.isSuccess(delegationFields) ? delegationFields.value : null,
    },
    capabilityPolicy: options.capabilityPolicy,
    llmModel: options.llmModel,
    llmAvailable: env.AI !== undefined,
  });
}

async function listDefinitions(platform: WorkflowPlatform, organizationId: OrganizationId) {
  const drafts = await platform.repositories.drafts.list({ organizationId: organizationId });
  const versions = await platform.repositories.versions.list({ organizationId: organizationId });
  if (Result.isFailure(drafts)) return drafts;
  if (Result.isFailure(versions)) return versions;
  const ids = new Set([
    ...drafts.value.map((draft) => String(draft.definition.id)),
    ...versions.value.map((version) => String(version.definitionId)),
  ]);
  return Result.succeed(
    [...ids].sort().map((id) => {
      const draft = drafts.value.find((candidate) => String(candidate.definition.id) === id);
      const published = versions.value.filter((version) => String(version.definitionId) === id);
      const latest = published.at(-1);
      return {
        id,
        name: draft?.definition.name ?? latest?.definition.name ?? id,
        draftRevision: draft?.revision ?? null,
        updatedAt: draft?.updatedAt ?? latest?.publishedAt ?? null,
        versions: published.map((version) => ({
          version: version.version,
          checksum: String(version.checksum),
          publishedAt: version.publishedAt,
        })),
      };
    }),
  );
}

async function validate(platform: WorkflowPlatform, organizationId: OrganizationId, raw: unknown) {
  const parsed = parseWorkflowDefinition(raw);
  if (Result.isFailure(parsed)) return { definition: null, issues: parsed.error, capabilities: [] };
  const validation = validateWorkflowDefinition(parsed.value);
  const reviewed = platform.capabilities
    ? await platform.capabilities.review({
        organizationId: organizationId,
        definition: parsed.value,
      })
    : Result.succeed([]);
  return {
    definition: parsed.value,
    issues: validation.valid ? [] : validation.issues,
    capabilities: Result.isSuccess(reviewed) ? reviewed.value : [],
  };
}

async function runView(
  platform: WorkflowPlatform,
  organizationId: OrganizationId,
  id: WorkflowRunId,
) {
  const record = await platform.repositories.runs.load({
    organizationId: organizationId,
    runId: id,
  });
  if (Result.isFailure(record)) return record;
  if (!record.value) return Result.succeed(null);
  const events = await platform.repositories.runs.listEvents({
    organizationId: organizationId,
    runId: id,
  });
  const children = await platform.repositories.correlations.listForRun({
    organizationId: organizationId,
    runId: id,
  });
  if (Result.isFailure(events)) return events;
  if (Result.isFailure(children)) return children;
  const childViews = [];
  for (const child of children.value) {
    const status = await platform.statuses.status({
      organizationId: organizationId,
      actionRequestId: child.childActionRequestId,
    });
    const childRun = await platform.repositories.runs.findByParentAction({
      organizationId: organizationId,
      actionRequestId: child.childActionRequestId,
    });
    childViews.push({
      actionRequestId: String(child.childActionRequestId),
      actionType: String(child.actionType),
      nodeRunId: String(child.nodeRunId),
      effectId: String(child.effectId),
      status: Result.isSuccess(status) ? (status.value?.status ?? null) : null,
      approvalRequired: Result.isSuccess(status) ? (status.value?.approvalRequired ?? null) : null,
      output: Result.isSuccess(status) ? (status.value?.output ?? null) : null,
      code: Result.isSuccess(status) ? (status.value?.code ?? null) : null,
      childRunId:
        Result.isSuccess(childRun) && childRun.value ? String(childRun.value.state.runId) : null,
    });
  }
  const version = await platform.repositories.versions.load({
    organizationId: organizationId,
    definitionId: record.value.state.definitionId,
    version: record.value.state.version,
  });
  return Result.succeed({
    run: {
      state: record.value.state,
      depth: record.value.depth,
      invocation: record.value.invocation,
      completionDelivered: record.value.completionDelivered,
      wakeAt: record.value.wakeAt ?? null,
    },
    definition: Result.isSuccess(version) ? (version.value?.definition ?? null) : null,
    events: events.value,
    children: childViews,
  });
}

async function actionView(
  env: WorkflowStudioOptions["env"],
  platform: WorkflowPlatform,
  organizationId: OrganizationId,
  id: ActionRequestId,
) {
  const status = await platform.statuses.status({
    organizationId: organizationId,
    actionRequestId: id,
  });
  if (Result.isFailure(status)) return Result.fail(status.error);
  const result = await platform.repositories.results.load({
    organizationId: organizationId,
    actionRequestId: id,
  });
  const runtime = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
    organizationId: organizationId,
    actionRequestId: id,
  });
  const run = await platform.repositories.runs.findByParentAction({
    organizationId: organizationId,
    actionRequestId: id,
  });
  const plan = await platform.repositories.plans.load({
    organizationId: organizationId,
    actionRequestId: id,
  });
  return Result.succeed({
    actionRequestId: String(id),
    status: status.value,
    result: Result.isSuccess(result) ? result.value : null,
    approval: Result.isSuccess(runtime) ? runtime.value : null,
    actor: plan.type === "found" ? plan.plan.evaluationSnapshot.actor : null,
    authority: plan.type === "found" ? plan.plan.evaluationSnapshot.authority : null,
    action:
      plan.type === "found" ? { type: plan.plan.action.type, input: plan.plan.action.input } : null,
    runId: Result.isSuccess(run) && run.value ? String(run.value.state.runId) : null,
    trace: await platform.trace(id),
  });
}

/** Workflow Studio（#162）のpreview API。`/preview/workflow/*` だけを扱い、それ以外はnull。 */
export async function handleWorkflowStudio(
  request: Request,
  options: WorkflowStudioOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${options.prefix}/`)) return null;
  const decoded = decodeUriComponent(url.pathname.slice(options.prefix.length + 1));
  if (Result.isFailure(decoded)) return problem(400, "invalid_path", "pathをdecodeできません");
  const segments = decoded.value.split("/").filter((segment) => segment.length > 0);
  const method = request.method;
  const { platform, env, organizationId, actor } = options;
  const [resource, id, sub, subId, subAction] = segments;

  if (method === "POST" && resource === "bootstrap") {
    return options.bootstrap ? options.bootstrap() : problem(404, "not_found", "Not Found");
  }
  if (method === "GET" && resource === "catalog") {
    const view = await catalogView(options);
    return Result.isFailure(view)
      ? problem(500, "catalog_failed", view.error.message)
      : json(view.value);
  }

  if (resource === "definitions") {
    if (method === "GET" && id === undefined) {
      const listed = await listDefinitions(platform, organizationId);
      return Result.isFailure(listed)
        ? problem(500, "list_failed", listed.error.message)
        : json({ definitions: listed.value });
    }
    const defId = id ? definitionId(id) : null;
    if (!defId) return problem(400, "invalid_definition_id", "definition idが不正です");
    if (method === "GET" && sub === undefined) {
      const draft = await platform.repositories.drafts.load({
        organizationId: organizationId,
        definitionId: defId,
      });
      const versions = await platform.repositories.versions.list({
        organizationId: organizationId,
        definitionId: defId,
      });
      const bindings = await platform.repositories.bindings.listForWorkflow({
        organizationId: organizationId,
        workflowDefinitionId: defId,
      });
      if (Result.isFailure(draft) || Result.isFailure(versions) || Result.isFailure(bindings)) {
        return problem(500, "load_failed", "definitionを読み込めません");
      }
      return json({ draft: draft.value, versions: versions.value, bindings: bindings.value });
    }
    if (method === "POST" && sub === "validate") {
      return json(await validate(platform, organizationId, (await body(request))["definition"]));
    }
    if (method === "PUT" && sub === undefined) {
      const input = await body(request);
      const checked = await validate(platform, organizationId, input["definition"]);
      if (!checked.definition || String(checked.definition.id) !== String(defId)) {
        return problem(422, "invalid_definition", "Workflow Definitionが不正です", {
          issues: checked.issues,
        });
      }
      const revision =
        typeof input["expectedRevision"] === "number" ? input["expectedRevision"] : null;
      const saved = await platform.publishing.saveDraft({
        organizationId: organizationId,
        definition: checked.definition,
        expectedRevision: revision,
        now: now(),
      });
      if (Result.isFailure(saved)) return problem(409, saved.error.code, saved.error.message);
      return json({
        revision: saved.value.revision,
        issues: checked.issues,
        capabilities: checked.capabilities,
      });
    }
    if (method === "POST" && sub === "publish") {
      const input = await body(request);
      const parsed = parseWorkflowDefinition(input["definition"]);
      if (Result.isFailure(parsed) || String(parsed.value.id) !== String(defId)) {
        return problem(422, "invalid_definition", "Workflow Definitionが不正です", {
          issues: Result.isFailure(parsed) ? parsed.error : [],
        });
      }
      const actionType =
        typeof input["actionType"] === "string" && input["actionType"].length > 0
          ? input["actionType"]
          : undefined;
      const published = await platform.publishing.publish({
        organizationId: organizationId,
        definition: parsed.value,
        publishedBy: actor,
        now: now(),
        ...(actionType ? { actionType } : {}),
      });
      if (Result.isFailure(published)) {
        return problem(422, published.error.code, published.error.message, {
          issues: published.error.issues ?? [],
        });
      }
      return json(published.value, { status: 201 });
    }
    if (method === "POST" && sub === "projection") {
      const input = await body(request);
      const versionNumber = typeof input["version"] === "number" ? input["version"] : null;
      const version = versionNumber
        ? await platform.repositories.versions.load({
            organizationId: organizationId,
            definitionId: defId,
            version: versionNumber,
          })
        : await platform.repositories.versions.latest({
            organizationId: organizationId,
            definitionId: defId,
          });
      if (Result.isFailure(version) || !version.value)
        return problem(404, "version_not_found", "publish済みversionがありません");
      const bindings = await platform.repositories.bindings.listForWorkflow({
        organizationId: organizationId,
        workflowDefinitionId: defId,
      });
      const composite = Result.isSuccess(bindings)
        ? bindings.value.find((binding) => binding.workflowVersion === version.value?.version)
        : undefined;
      const projected = await platform.projector.project({
        organizationId: organizationId,
        version: version.value,
        input: isRecord(input["input"]) ? (input["input"] as JsonObject) : {},
        requester: {
          actor: actor,
          authority: { principal: actor },
          origin: { type: "ui" },
          organizationSettings: {},
          attributes: {},
        },
        now: now(),
        ...(composite ? { compositeActionType: composite.actionType } : {}),
      });
      return Result.isFailure(projected)
        ? problem(500, projected.error.code, projected.error.message)
        : json(projected.value);
    }
  }

  if (resource === "programs") {
    const authoring = platform.programAuthoring;
    if (!authoring) return problem(503, "sandbox_unavailable", "sandboxが設定されていません");
    if (method === "GET") {
      const listed = await platform.repositories.programs.list({ organizationId: organizationId });
      return Result.isFailure(listed)
        ? problem(500, "list_failed", listed.error.message)
        : json({
            programs: listed.value.map(({ source, ...version }) => ({
              ...version,
              sourceBytes: source.length,
              source,
            })),
          });
    }
    if (method === "POST" && id === "draft") {
      const input = await body(request);
      const drafted = await authoring.draft({
        organizationId: organizationId,
        programId: typeof input["programId"] === "string" ? input["programId"] : "program:untitled",
        ...(typeof input["instruction"] === "string" ? { instruction: input["instruction"] } : {}),
        ...(typeof input["source"] === "string" ? { source: input["source"] } : {}),
        ...(typeof input["description"] === "string" ? { description: input["description"] } : {}),
        inputSchema: (isRecord(input["inputSchema"])
          ? input["inputSchema"]
          : { type: "any" }) as never,
        outputSchema: (isRecord(input["outputSchema"])
          ? input["outputSchema"]
          : { type: "any" }) as never,
        requestedCapabilities: (isRecord(input["requestedCapabilities"])
          ? input["requestedCapabilities"]
          : {}) as never,
        samples: (Array.isArray(input["samples"]) ? input["samples"] : []) as never,
        ...(typeof input["model"] === "string" ? { model: input["model"] } : {}),
      });
      return Result.isFailure(drafted)
        ? problem(422, drafted.error.code, drafted.error.message)
        : json(drafted.value);
    }
    if (method === "POST" && id === "publish") {
      const input = await body(request);
      if (!isRecord(input["draft"])) return problem(400, "invalid_draft", "draftが必要です");
      const published = await authoring.publish({
        organizationId: organizationId,
        draft: input["draft"] as never,
        samples: (Array.isArray(input["samples"]) ? input["samples"] : []) as never,
        publishedBy: String(actor.id),
      });
      return Result.isFailure(published)
        ? problem(422, published.error.code, published.error.message)
        : json(published.value, { status: 201 });
    }
  }

  if (resource === "runs") {
    if (method === "POST" && id === undefined) {
      const input = await body(request);
      const type = parseBrand("ActionType", input["actionType"]);
      const resourceId = parseBrand(
        "ResourceId",
        typeof input["resourceId"] === "string" && input["resourceId"]
          ? input["resourceId"]
          : `studio-${Date.now()}`,
      );
      const resourceType = parseBrand("ResourceType", "workflow_subject");
      if (
        Result.isFailure(type) ||
        Result.isFailure(resourceId) ||
        Result.isFailure(resourceType)
      ) {
        return problem(400, "invalid_action", "actionTypeが必要です");
      }
      const submitted = await platform.service.submit({
        action: {
          type: type.value,
          resource: { type: resourceType.value, id: resourceId.value },
          input: isRecord(input["input"]) ? input["input"] : {},
        },
        trustedContext: {
          actor: actor,
          authority: { principal: actor },
          origin: { type: "ui" },
          organization: { id: organizationId, settings: {} },
          now: now(),
        },
        clientReference: "workflow-studio",
      });
      if (Result.isFailure(submitted)) {
        return problem(422, submitted.error.code, submitted.error.message, {
          executionErrorCode: submitted.error.executionErrorCode ?? null,
        });
      }
      if (submitted.value.type !== "accepted")
        return problem(403, submitted.value.code, submitted.value.reason);
      return json(
        {
          actionRequestId: String(submitted.value.actionRequestId),
          status: submitted.value.view.status,
        },
        { status: 201 },
      );
    }
    if (method === "GET" && id === undefined) {
      const listed = await platform.repositories.runs.list({
        organizationId: organizationId,
        limit: 50,
      });
      return Result.isFailure(listed)
        ? problem(500, "list_failed", listed.error.message)
        : json({
            runs: listed.value.map((record) => ({
              runId: String(record.state.runId),
              definitionId: String(record.state.definitionId),
              version: record.state.version,
              status: record.state.status,
              depth: record.depth,
              parentActionRequestId: record.invocation.parentAction
                ? String(record.invocation.parentAction.actionRequestId)
                : null,
              createdAt: record.state.createdAt,
              completedAt: record.state.completedAt ?? null,
            })),
          });
    }
    const run = id ? runId(id) : null;
    if (!run) return problem(400, "invalid_run_id", "run idが不正です");
    if (method === "GET" && sub === undefined) {
      const view = await runView(platform, organizationId, run);
      if (Result.isFailure(view)) return problem(500, view.error.code, view.error.message);
      return view.value
        ? json(view.value)
        : problem(404, "run_not_found", "WorkflowRunが見つかりません");
    }
    if (method === "POST" && sub === "advance") {
      const advanced = await platform.runtime.advance({
        organizationId: organizationId,
        runId: run,
      });
      return Result.isFailure(advanced)
        ? problem(500, advanced.error.code, advanced.error.message)
        : json(advanced.value);
    }
    if (method === "POST" && sub === "cancel") {
      const cancelled = await platform.runtime.cancel({
        organizationId: organizationId,
        runId: run,
        reason: "cancelled from Workflow Studio",
      });
      return Result.isFailure(cancelled)
        ? problem(500, cancelled.error.code, cancelled.error.message)
        : json(cancelled.value);
    }
    if (method === "POST" && sub === "effects" && subId && subAction === "input") {
      const effectId = parseWorkflowId("EffectId", subId);
      if (Result.isFailure(effectId))
        return problem(400, "invalid_effect_id", "effect idが不正です");
      const input = await body(request);
      const delivered = await platform.runtime.deliver({
        organizationId: organizationId,
        runId: run,
        event: {
          type: "effect_completed",
          effectId: effectId.value,
          output: (input["value"] ?? null) as never,
        },
      });
      return Result.isFailure(delivered)
        ? problem(409, delivered.error.code, delivered.error.message)
        : json(delivered.value);
    }
  }

  if (resource === "actions") {
    const action = id ? actionRequestId(id) : null;
    if (!action) return problem(400, "invalid_action_request_id", "ActionRequest idが不正です");
    if (method === "GET" && sub === undefined) {
      const view = await actionView(env, platform, organizationId, action);
      return Result.isFailure(view)
        ? problem(500, view.error.code, view.error.message)
        : json(view.value);
    }
    if (method === "POST" && sub === "decision" && options.decide)
      return options.decide(action, await body(request));
  }

  return problem(404, "not_found", "Not Found");
}
