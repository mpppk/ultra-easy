import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/authorization/")({
  component: () => <Navigate to="/admin/authorization/explorer" replace />,
});
