import { createFileRoute } from "@tanstack/react-router";

import { proxyApprovalTask } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/approval-tasks/$taskId/decisions")({
  server: {
    handlers: {
      POST: ({ request, params }) => proxyApprovalTask(request, consoleEnv(), params.taskId, true),
    },
  },
});
