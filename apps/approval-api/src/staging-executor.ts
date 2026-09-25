import { WorkerEntrypoint } from "cloudflare:workers";

import { serveActionExecutorRegistry } from "@app/approval-runtime-cloudflare";

import {
  createActionExecutorRegistry,
  type ActionExecutorRegistryEnv,
} from "./executor-registry.ts";

/**
 * Workflow経路のAction Executor registry (service binding)。
 * 承認不要の同期実行と同じ`createActionExecutorRegistry`でexecutorKeyをdispatchする
 * （governance → GovernanceActionExecutor、authorization → relationship mutation、
 * staging → side-effect sink）。未登録のexecutorKeyは成功扱いにせず422にする。
 * Workflow側がaction_resultsへ永続化する。
 */
export class StagingActionExecutor extends WorkerEntrypoint<ActionExecutorRegistryEnv> {
  override async fetch(request: Request): Promise<Response> {
    return serveActionExecutorRegistry(request, createActionExecutorRegistry(this.env));
  }
}
