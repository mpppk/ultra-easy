import { createFileRoute } from "@tanstack/react-router";

import { AdminShell } from "#components/authorization/admin-shell";

export const Route = createFileRoute("/admin/authorization")({
  head: () => ({ meta: [{ title: "Authorization Console · ultra-easy" }] }),
  component: AdminShell,
});
