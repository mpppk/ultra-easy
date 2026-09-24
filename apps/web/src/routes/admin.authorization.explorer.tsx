import { createFileRoute } from "@tanstack/react-router";

import { ExplorerPage } from "#components/authorization/explorer";
import { useConsoleCatalog } from "#hooks/use-console-catalog";

export const Route = createFileRoute("/admin/authorization/explorer")({
  component: function Explorer() {
    const catalog = useConsoleCatalog();
    return <ExplorerPage catalog={catalog.data} />;
  },
});
