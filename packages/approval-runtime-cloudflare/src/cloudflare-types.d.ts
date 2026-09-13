/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-plugin/types" />

import type { ActionWorkflowEnv, ActionWorkflowParams } from "./workflow.ts";

declare global {
  namespace Cloudflare {
    interface Env extends ActionWorkflowEnv {
      ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
    }
  }
}

export {};
