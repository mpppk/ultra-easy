import { safeLogRecord, systemCorrelation, type OrganizationId } from "@app/approval-core";
import {
  ServiceBindingActionAuthorizer,
  telemetrySinkFromEnv,
  type ActionServiceBinding,
  type ActionWorkflowParams,
  type TelemetryEnv,
} from "@app/approval-runtime-cloudflare";
import {
  DEFAULT_RESOURCE_LIMITS,
  LlmProgramCodeGenerator,
  staticCapabilityPolicy,
  type CapabilityPolicy,
} from "@app/workflow-application";
import { createWorkflowPlatform, type WorkflowPlatform } from "@app/workflow-platform";
import {
  CloudflareWorkflowRunnerControl,
  WorkersAiLlmProvider,
  type WorkflowRunnerParams,
  type WorkersAiBinding,
} from "@app/workflow-runtime-cloudflare";
import { QuickJsSandbox } from "@app/workflow-sandbox";
import { workerdQuickJsModule } from "@app/workflow-sandbox/workerd";

import {
  createPrimitiveActionExecutors,
  type ActionExecutorRegistryEnv,
} from "./executor-registry.ts";
import { StagingSchemaResolver } from "./staging-schema-resolver.ts";
import { CloudflareActionWorkflowStarter } from "./workflow-starter.ts";

export type ProductionWorkflowEnv = ActionExecutorRegistryEnv &
  TelemetryEnv & {
    DB: D1Database;
    ACTION_AUTHORIZER: ActionServiceBinding;
    ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
    WORKFLOW_RUNNER: Workflow<WorkflowRunnerParams>;
    AI?: WorkersAiBinding;
    AUTH0_ORGANIZATION_ID: string;
    WORKFLOW_LLM_MODEL?: string;
    WORKFLOW_CODE_MODEL?: string;
  };

/** Explicit grants for the initial production host. Policy binding API follows in #199. */
export function productionCapabilityPolicy(env: ProductionWorkflowEnv): CapabilityPolicy {
  return {
    actions: [{ actionType: "ticket.update" }, { actionType: "ticket.escalate" }],
    llm: {
      models: [env.WORKFLOW_LLM_MODEL || "@cf/qwen/qwen2.5-coder-32b-instruct"],
      maxCalls: 5,
      maxInputTokens: 8000,
      maxOutputTokens: 2048,
      maxCostMicroUsd: 1_000_000,
    },
    maxEffects: 16,
  };
}

const platforms = new WeakMap<object, WorkflowPlatform>();

/** approval-api is the production composition root; all workflow state shares its D1. */
export function productionWorkflowPlatform(
  env: ProductionWorkflowEnv,
  inputOrganizationId: OrganizationId,
): WorkflowPlatform {
  const cached = platforms.get(env);
  if (cached) return cached;
  const organizationId = inputOrganizationId;
  const runner = new CloudflareWorkflowRunnerControl(env.WORKFLOW_RUNNER);
  const ai = env.AI ? new WorkersAiLlmProvider(env.AI) : null;
  const platform = createWorkflowPlatform({
    db: env.DB,
    organizationId,
    clock: { now: () => new Date().toISOString() },
    authorizer: new ServiceBindingActionAuthorizer(env.ACTION_AUTHORIZER, organizationId),
    primitiveExecutors: createPrimitiveActionExecutors(env),
    workflowStarter: new CloudflareActionWorkflowStarter(env.ACTION_WORKFLOW),
    schemaResolver: new StagingSchemaResolver(),
    scheduler: () => ({ schedule: (key) => runner.start(key) }),
    sandbox: new QuickJsSandbox(workerdQuickJsModule),
    ...(ai
      ? {
          codeGenerator: new LlmProgramCodeGenerator({
            provider: ai,
            model: env.WORKFLOW_CODE_MODEL || "@cf/qwen/qwen2.5-coder-32b-instruct",
            maxOutputTokens: 1024,
          }),
        }
      : {}),
    pollIntervalSeconds: 10,
    governance: {
      capabilityPolicy: staticCapabilityPolicy(productionCapabilityPolicy(env)),
      ...(ai ? { llmProvider: ai } : {}),
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
    },
    onEffectRetry: (input) => {
      // Operational telemetry must never contain effect inputs or credentials.
      telemetrySinkFromEnv(env).emit(
        safeLogRecord({
          level: "warn",
          event: "workflow.retry",
          correlation: systemCorrelation({
            component: "workflow",
            operation: `workflow.effect.${input.kind}`,
            organizationId: input.organizationId,
          }),
          attributes: { errorCode: input.code, retriable: true },
        }),
      );
    },
  });
  platforms.set(env, platform);
  return platform;
}
