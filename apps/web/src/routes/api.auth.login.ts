import { createFileRoute } from "@tanstack/react-router";

import { login } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: ({ request }) => login(request, consoleEnv()),
    },
  },
});
