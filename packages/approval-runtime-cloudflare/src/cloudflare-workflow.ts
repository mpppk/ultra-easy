import { ConsoleTelemetrySink } from "@app/approval-core";
import {
  D1ActionEventRepository,
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
  D1PublicApiRepository,
} from "@app/approval-d1";
import { fgaTokenSupplierFromEnv, OpenFgaApproverResolver, OpenFgaClient } from "@app/approval-fga";

import { ServiceBindingActionAuthorizer, ServiceBindingActionExecutor } from "./service-binding.ts";
import { createActionWorkflow } from "./workflow.ts";
import type { ActionWorkflowDependencies, ActionWorkflowEnv } from "./workflow-dependencies.ts";

const dependencyCache = new WeakMap<object, ActionWorkflowDependencies>();

/**
 * Cloudflare（D1 / OpenFGA / service binding）でのActionWorkflowの依存（#106）。
 * isolate内ではenvごとに1回だけ組み立て、FGA tokenのcacheやrepositoryをstep間で共有する（#90）。
 */
export function cloudflareWorkflowDependencies(env: ActionWorkflowEnv): ActionWorkflowDependencies {
  const cached = dependencyCache.get(env);
  if (cached) return cached;

  const telemetry = new ConsoleTelemetrySink();
  const tokenSupplier = fgaTokenSupplierFromEnv(env);
  const dependencies: ActionWorkflowDependencies = {
    plans: new D1MaterializedPlanRepository(env.DB),
    projections: new D1ApprovalRuntimeProjectionRepository(env.DB),
    events: new D1ActionEventRepository(env.DB),
    results: new D1ActionResultProjectionRepository(env.DB),
    commands: new D1PublicApiRepository(env.DB),
    approverResolver: (scope) =>
      new OpenFgaApproverResolver(
        new OpenFgaClient({
          apiUrl: env.OPENFGA_API_URL,
          storeId: env.OPENFGA_STORE_ID,
          authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
          organizationId: scope.organizationId,
          actionRequestId: scope.actionRequestId,
          ...(env.OPENFGA_API_TOKEN ? { token: env.OPENFGA_API_TOKEN } : {}),
          ...(tokenSupplier ? { tokenSupplier } : {}),
          telemetry,
          ...(env.OPENFGA_ASSUME_LIST_USERS_COMPLETE === "true"
            ? { listUsersCompleteness: "assume_complete" as const }
            : {}),
        }),
      ),
    actionAuthorizer: (scope) =>
      env.ACTION_AUTHORIZER
        ? new ServiceBindingActionAuthorizer(
            env.ACTION_AUTHORIZER,
            scope.organizationId,
            scope.actionRequestId,
          )
        : null,
    actionExecutor: (executorKey, guaranteeLevel) =>
      env.ACTION_EXECUTOR
        ? new ServiceBindingActionExecutor(env.ACTION_EXECUTOR, executorKey, guaranteeLevel)
        : null,
    telemetry,
    executionMode: env.ACTION_EXECUTION_MODE === "approval_only" ? "approval_only" : "execute",
  };
  dependencyCache.set(env, dependencies);
  return dependencies;
}

/** 本番（approval-api / approval-runtime）がexportするWorkflow class。 */
export const ActionWorkflow = createActionWorkflow(cloudflareWorkflowDependencies);
