import { createFileRoute } from "@tanstack/react-router";

import { proxyApprovalTask } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/approval-tasks/$taskId")({
  server: {
    handlers: {
      GET: ({ request, params }) => proxyApprovalTask(request, consoleEnv(), params.taskId),
    },
  },
});
