import { createFileRoute } from "@tanstack/react-router";

import { EmptyState } from "#components/layout/states";

export const Route = createFileRoute("/admin/authorization/audit")({
  component: () => <EmptyState title="Audit" description="Available with M9-4 (#120)." />,
});
