import { Result } from "@praha/byethrow";

import { ActionRequestDependencyError } from "@app/approval-application";
import type { ActionWorkflowStarter } from "@app/approval-application";
import {
  approve,
  brandLiteral,
  definePolicy,
  field,
  gt,
  literal,
  parseBrand,
  rule,
  user,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionExecutorError,
  MaterializedApprovalPlan,
  SchemaResolver,
} from "@app/approval-core";
import {
  actionWorkflowInstanceId,
  type ActionWorkflowParams,
} from "@app/approval-runtime-cloudflare";
import { DEFAULT_RESOURCE_LIMITS, staticCapabilityPolicy } from "@app/workflow-application";
import type { CapabilityPolicy } from "@app/workflow-application";
import { createWorkflowPlatform } from "@app/workflow-platform";
import type { WorkflowPlatform } from "@app/workflow-platform";
import {
  CloudflareWorkflowRunnerControl,
  WorkersAiLlmProvider,
} from "@app/workflow-runtime-cloudflare";
import type { WorkersAiBinding, WorkflowRunnerParams } from "@app/workflow-runtime-cloudflare";
import { QuickJsSandbox } from "@app/workflow-sandbox";
import { workerdQuickJsModule } from "@app/workflow-sandbox/workerd";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { PREVIEW_EXECUTOR_KEY, PREVIEW_ORGANIZATION_ID } from "./preview-plan.ts";

export type WorkflowPreviewEnv = {
  DB: D1Database;
  ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
  WORKFLOW_RUNNER: Workflow<WorkflowRunnerParams>;
  AI?: WorkersAiBinding;
};

/** Preview専用のside-effect mock。外部副作用を持たないためidempotent。 */
export class PreviewSinkActionExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    return Result.succeed({
      status: "succeeded",
      output: {
        preview: true,
        actionType: String(request.action.type),
        resourceId: String(request.action.resource.id),
        input: request.action.input,
        idempotencyKey: request.idempotencyKey,
      },
    });
  }
}

/** Preview専用のAuthorizer（関係ベースの認可はpreviewでは行わない）。委任chainの構造・scope・条件はcoreが検証する。 */
const previewAuthorizer: ActionAuthorizer = {
  async check(input) {
    return Result.succeed({
      type: "allow" as const,
      evidence: {
        evaluatedAt: input.evaluatedAt,
        consistency: input.consistency,
        provider: "preview-authorizer",
      },
    });
  },
};

const anyObjectSchema = {
  "~standard": {
    version: 1,
    vendor: "preview",
    validate(value: unknown) {
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "input must be an object" }] };
    },
  },
} satisfies StandardSchemaV1<unknown, Record<string, unknown>>;

const previewSchemaResolver: SchemaResolver = {
  resolve: async () => Result.succeed(anyObjectSchema),
};

/** Preview catalogのprimitive Action（外部副作用なしのsink executorで実行する）。 */
export const PREVIEW_PRIMITIVE_ACTIONS = [
  "google.create_account",
  "github.add_member",
  "equipment.order",
  "payment.execute",
  "notify.send",
] as const;

export const PREVIEW_LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export const PREVIEW_CAPABILITY_POLICY: CapabilityPolicy = {
  actions: [
    { actionType: "notify.send" },
    { actionType: "equipment.order" },
    { actionType: "payment.execute" },
  ],
  llm: {
    models: [PREVIEW_LLM_MODEL],
    maxCalls: 5,
    maxInputTokens: 8000,
    maxOutputTokens: 2048,
    maxCostMicroUsd: 1_000_000,
  },
  maxEffects: 16,
};

class PreviewActionWorkflowStarter implements ActionWorkflowStarter {
  constructor(private readonly workflow: Workflow<ActionWorkflowParams>) {}

  async start(input: { plan: MaterializedApprovalPlan; startedAt: string }) {
    const id = await actionWorkflowInstanceId(input.plan);
    const created = await Result.fn({
      try: () =>
        this.workflow.create({
          id,
          params: {
            organizationId: input.plan.organizationId,
            actionRequestId: input.plan.actionRequestId,
            approvalPlanChecksum: input.plan.approvalPlanChecksum,
          },
        }),
      catch: (error) =>
        new ActionRequestDependencyError(
          "workflow_start_failed",
          true,
          error instanceof Error ? error.message : String(error),
        ),
    })();
    if (Result.isFailure(created)) {
      const existing = await Result.fn({
        try: () => this.workflow.get(id),
        catch: () => created.error,
      })();
      if (Result.isFailure(existing)) return created;
    }
    return Result.succeed({ workflowInstanceId: id });
  }
}

const platforms = new WeakMap<object, WorkflowPlatform>();

/** Preview worker上のWorkflow platform（isolate内でenvごとに1回だけ組み立てる）。 */
export function previewWorkflowPlatform(env: WorkflowPreviewEnv): WorkflowPlatform {
  const cached = platforms.get(env);
  if (cached) return cached;
  const runner = new CloudflareWorkflowRunnerControl(env.WORKFLOW_RUNNER);
  const platform = createWorkflowPlatform({
    db: env.DB,
    organizationId: PREVIEW_ORGANIZATION_ID,
    clock: { now: () => new Date().toISOString() },
    authorizer: previewAuthorizer,
    primitiveExecutors: { [String(PREVIEW_EXECUTOR_KEY)]: new PreviewSinkActionExecutor() },
    workflowStarter: new PreviewActionWorkflowStarter(env.ACTION_WORKFLOW),
    schemaResolver: previewSchemaResolver,
    scheduler: () => ({ schedule: (key) => runner.start(key) }),
    sandbox: new QuickJsSandbox(workerdQuickJsModule),
    pollIntervalSeconds: 10,
    governance: {
      capabilityPolicy: staticCapabilityPolicy(PREVIEW_CAPABILITY_POLICY),
      ...(env.AI ? { llmProvider: new WorkersAiLlmProvider(env.AI) } : {}),
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
    },
  });
  platforms.set(env, platform);
  return platform;
}

const PREVIEW_ACTOR = { type: "user" as const, id: brandLiteral("UserId", "user:alice") };

/** Preview catalogとApproval Policyを冪等にinstallする。 */
export async function bootstrapPreviewCatalog(platform: WorkflowPlatform, now: string) {
  for (const actionType of PREVIEW_PRIMITIVE_ACTIONS) {
    const key = parseBrand("ActionDefinitionKey", `preview:${actionType}`);
    const type = parseBrand("ActionType", actionType);
    const schemaKey = parseBrand("SchemaKey", `preview-schema:${actionType}`);
    if (Result.isFailure(key) || Result.isFailure(type) || Result.isFailure(schemaKey)) {
      return Result.fail(new Error(`invalid preview action: ${actionType}`));
    }
    const definition: ActionDefinition = {
      key: key.value,
      version: 1,
      actionType: type.value,
      inputSchema: { key: schemaKey.value, version: 1 },
      executorKey: PREVIEW_EXECUTOR_KEY,
    };
    const published = await platform.catalog.publish({
      organizationId: PREVIEW_ORGANIZATION_ID,
      definition,
      publishedBy: PREVIEW_ACTOR,
      publishedAt: now,
    });
    if (Result.isFailure(published)) return published;
  }
  const source = brandLiteral("ActionRequestId", "bootstrap:workflow-preview");
  const policy = await platform.governance.publishApprovalPolicy({
    organizationId: PREVIEW_ORGANIZATION_ID,
    sourceActionRequestId: source,
    actor: PREVIEW_ACTOR,
    occurredAt: now,
    version: 1,
    policy: definePolicy({
      key: "policy:preview-large-payment",
      name: "10,000を超える支払いはbobの承認が必要",
      rules: [
        rule("large", {
          when: gt(field("action.input.amount"), literal(10_000)),
          flow: approve({ key: "finance", approver: user(literal("user:bob")) }),
        }),
      ],
    }),
  });
  if (Result.isFailure(policy)) return policy;
  const binding = await platform.governance.updateApprovalPolicyBinding({
    organizationId: PREVIEW_ORGANIZATION_ID,
    sourceActionRequestId: source,
    actor: PREVIEW_ACTOR,
    occurredAt: now,
    binding: {
      id: brandLiteral("ApprovalPolicyBindingId", "binding:preview-large-payment"),
      organizationId: PREVIEW_ORGANIZATION_ID,
      policyKey: brandLiteral("ApprovalPolicyKey", "policy:preview-large-payment"),
      selector: { actionTypes: [brandLiteral("ActionType", "payment.execute")] },
      enabled: true,
    },
  });
  if (Result.isFailure(binding)) return binding;
  return Result.succeed({ actions: PREVIEW_PRIMITIVE_ACTIONS.length });
}

export { PREVIEW_ACTOR };
