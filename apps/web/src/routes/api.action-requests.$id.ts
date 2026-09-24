import { createFileRoute } from "@tanstack/react-router";

import { proxyGetActionRequest } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/action-requests/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => proxyGetActionRequest(request, consoleEnv(), params.id),
    },
  },
});
