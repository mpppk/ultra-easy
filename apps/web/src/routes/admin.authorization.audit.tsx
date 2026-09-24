import { createFileRoute } from "@tanstack/react-router";

import { AuditPage } from "#components/authorization/audit";
import { useConsoleCatalog } from "#hooks/use-console-catalog";

export const Route = createFileRoute("/admin/authorization/audit")({
  component: function Audit() {
    const catalog = useConsoleCatalog();
    return <AuditPage catalog={catalog.data} />;
  },
});
