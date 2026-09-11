import type { ActionRequestId, ApprovalPlanChecksum, OrganizationId } from "./domain/brand.ts";
import type { MaterializedApprovalPlan } from "./materialization.ts";

export type MaterializedPlanSaveResult =
  | { type: "created" }
  | { type: "existing" }
  | { type: "invalid_plan"; message: string }
  | { type: "repository_error"; message: string }
  | {
      type: "conflict";
      existingApprovalPlanChecksum: ApprovalPlanChecksum;
    };

export type MaterializedPlanLoadResult =
  | { type: "found"; plan: MaterializedApprovalPlan }
  | { type: "not_found" }
  | {
      type: "checksum_mismatch";
      actualApprovalPlanChecksum: ApprovalPlanChecksum;
    }
  | { type: "invalid_plan"; message: string }
  | { type: "repository_error"; message: string };

/**
 * Materialized Approval PlanはINSERT-onlyとして扱う。
 * runtime stateの更新はこのPortの責務に含めない。
 */
export interface MaterializedPlanRepository {
  save(plan: MaterializedApprovalPlan): Promise<MaterializedPlanSaveResult>;

  load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    expectedApprovalPlanChecksum?: ApprovalPlanChecksum;
  }): Promise<MaterializedPlanLoadResult>;
}
