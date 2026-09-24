import { createFileRoute } from "@tanstack/react-router";

import { proxyCreateActionRequest } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/action-requests")({
  server: {
    handlers: {
      POST: ({ request }) => proxyCreateActionRequest(request, consoleEnv()),
    },
  },
});
