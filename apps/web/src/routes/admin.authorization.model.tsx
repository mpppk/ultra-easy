import { createFileRoute } from "@tanstack/react-router";

import { ModelPage } from "#components/authorization/model-view";

export const Route = createFileRoute("/admin/authorization/model")({
  component: ModelPage,
});
