import { createFileRoute } from "@tanstack/react-router";

import { proxyActionRequestTasks } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/action-requests/$id/tasks")({
  server: {
    handlers: {
      GET: ({ request, params }) => proxyActionRequestTasks(request, consoleEnv(), params.id),
    },
  },
});
