/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-plugin/types" />

import type { WorkflowRunnerParams } from "./runner.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      WORKFLOW_RUNNER: Workflow<WorkflowRunnerParams>;
    }
  }
}

export {};
