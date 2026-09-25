import type { Result } from "@praha/byethrow";
import type { D1Database } from "@cloudflare/workers-types";

import type {
  ActionAuthorizer,
  ActionEventRecord,
  ActionEventRepository,
  ActionExecutionGuaranteeLevel,
  ActionExecutor,
  ActionExecutorError,
  ActionRequestId,
  ActionResultRepository,
  ApprovalPlanChecksum,
  ApprovalRuntimeProjectionRepositoryError,
  ApprovalRuntimeProjectionWriteResult,
  ApprovalRuntimeState,
  ApproverResolver,
  ExecutorKey,
  MaterializedPlanLoadResult,
  OrganizationId,
  TelemetrySink,
  VersionedApprovalRuntimeProjection,
} from "@app/approval-core";

import type { TelemetryEnv } from "./analytics-engine-telemetry.ts";
import type { ActionExecutorDescription, ActionServiceBinding } from "./service-binding.ts";

// ActionWorkflowのport（#106）。Workflowのロジックはこの型だけに依存し、D1 / OpenFGA /
// service bindingの具象は`cloudflareWorkflowDependencies`（cloudflare-workflow.ts）が組み立てる。

export interface WorkflowPlanStore {
  loadForWorkflow(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    expectedApprovalPlanChecksum: ApprovalPlanChecksum;
  }): Promise<MaterializedPlanLoadResult>;
}

export interface WorkflowRuntimeProjectionStore {
  compareAndReplace(input: {
    organizationId: OrganizationId;
    state: ApprovalRuntimeState;
    events?: readonly ActionEventRecord[];
    expectedVersion: number | null;
    writer: string;
  }): Result.ResultAsync<
    ApprovalRuntimeProjectionWriteResult,
    ApprovalRuntimeProjectionRepositoryError
  >;
  loadVersioned(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<
    VersionedApprovalRuntimeProjection | null,
    ApprovalRuntimeProjectionRepositoryError
  >;
  load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ApprovalRuntimeState | null, ApprovalRuntimeProjectionRepositoryError>;
}

export type WorkflowCommandProblem = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
};

/** WorkflowがDecisionを受理 / 却下した結果をDecision commandへ書き戻すport（#79）。 */
export interface WorkflowCommandOutcomeRecorder {
  resolveOutcome(input: {
    organizationId: OrganizationId;
    commandId: string;
    status: "applied" | "rejected";
    resolvedAt: string;
    error?: WorkflowCommandProblem;
  }): Result.ResultAsync<
    { updated: boolean },
    { code: string; message: string; retriable: boolean }
  >;
}

/** 実行前にregistryへ登録と保証を問い合わせられるexecutor（service binding越しのregistry）。 */
export type DescribableActionExecutor = ActionExecutor & {
  describe(): Result.ResultAsync<ActionExecutorDescription, ActionExecutorError>;
};

export type ActionWorkflowScope = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
};

export type ActionWorkflowDependencies = {
  plans: WorkflowPlanStore;
  projections: WorkflowRuntimeProjectionStore;
  events: ActionEventRepository;
  results: ActionResultRepository;
  commands: WorkflowCommandOutcomeRecorder;
  approverResolver(scope: ActionWorkflowScope): ApproverResolver;
  /** 実行直前の再認可。未設定ならnull（authorization_check_failedで終端する）。 */
  actionAuthorizer(scope: ActionWorkflowScope): ActionAuthorizer | null;
  /** executorKeyのexecutor。未設定ならnull（execution_failedで終端する）。 */
  actionExecutor(
    executorKey: ExecutorKey,
    guaranteeLevel?: ActionExecutionGuaranteeLevel,
  ): DescribableActionExecutor | null;
  telemetry: TelemetrySink;
  executionMode: "execute" | "approval_only";
};

export type ActionWorkflowEnv = TelemetryEnv & {
  DB: D1Database;
  ACTION_AUTHORIZER?: ActionServiceBinding;
  ACTION_EXECUTOR?: ActionServiceBinding;
  ACTION_EXECUTION_MODE?: "execute" | "approval_only";
  OPENFGA_API_URL: string;
  OPENFGA_STORE_ID: string;
  OPENFGA_AUTHORIZATION_MODEL_ID: string;
  OPENFGA_ASSUME_LIST_USERS_COMPLETE?: string;
  OPENFGA_API_TOKEN?: string;
  /** client credentialsのtoken endpoint / audience（#90）。未設定はOpenFGA Cloud既定。 */
  FGA_API_TOKEN_ISSUER?: string;
  FGA_API_AUDIENCE?: string;
  FGA_CLIENT_ID?: string;
  FGA_CLIENT_SECRET?: string;
};
