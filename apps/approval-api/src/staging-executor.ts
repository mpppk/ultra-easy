import { WorkerEntrypoint } from "cloudflare:workers";
import { Result } from "@praha/byethrow";
import { parseBrand } from "@app/approval-core";

import { serveActionExecutorRegistry } from "@app/approval-runtime-cloudflare";
import { productionWorkflowPlatform, type ProductionWorkflowEnv } from "./workflow-platform.ts";

/**
 * Workflow経路のAction Executor registry (service binding)。
 * 承認不要の同期実行と同じ`createActionExecutorRegistry`でexecutorKeyをdispatchする
 * （governance → GovernanceActionExecutor、authorization → relationship mutation、
 * staging → side-effect sink）。未登録のexecutorKeyは成功扱いにせず422にする。
 * Workflow側がaction_resultsへ永続化する。
 */
export class StagingActionExecutor extends WorkerEntrypoint<ProductionWorkflowEnv> {
  override async fetch(request: Request): Promise<Response> {
    const organizationId = parseBrand("OrganizationId", this.env.AUTH0_ORGANIZATION_ID);
    if (Result.isFailure(organizationId)) {
      return Response.json({ code: "invalid_organization_id" }, { status: 503 });
    }
    if (
      request.method === "POST" &&
      request.headers.get("x-ue-organization-id") !== String(organizationId.value)
    ) {
      return Response.json({ code: "organization_mismatch" }, { status: 403 });
    }
    return serveActionExecutorRegistry(
      request,
      productionWorkflowPlatform(this.env, organizationId.value).registry,
    );
  }
}
