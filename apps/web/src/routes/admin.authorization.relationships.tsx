import { createFileRoute } from "@tanstack/react-router";

import { RelationshipsPage } from "#components/authorization/relationships";
import { useConsoleCatalog } from "#hooks/use-console-catalog";

export const Route = createFileRoute("/admin/authorization/relationships")({
  component: function Relationships() {
    const catalog = useConsoleCatalog();
    return <RelationshipsPage catalog={catalog.data} />;
  },
});
