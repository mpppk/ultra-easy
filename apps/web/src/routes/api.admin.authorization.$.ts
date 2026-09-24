import { createFileRoute } from "@tanstack/react-router";

import { proxyAdminRequest } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/admin/authorization/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyAdminRequest(request, consoleEnv()),
      POST: ({ request }) => proxyAdminRequest(request, consoleEnv()),
    },
  },
});
