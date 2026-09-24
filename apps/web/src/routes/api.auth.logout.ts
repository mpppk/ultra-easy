import { createFileRoute } from "@tanstack/react-router";

import { logout } from "../server/console-api.ts";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: ({ request }) => logout(request),
    },
  },
});
