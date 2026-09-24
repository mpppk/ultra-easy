import { Link, createFileRoute } from "@tanstack/react-router";

import { PageContainer, PageHeader, PageSection } from "#components/layout/page";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#components/ui/card";

export const Route = createFileRoute("/")({ component: Home });

const surfaces = [
  {
    to: "/preview/approval-runtime",
    title: "Approval runtime (preview)",
    description: "Preview harness for the approval workflow runtime.",
    badge: "preview",
  },
  {
    to: "/preview/operator-dashboard",
    title: "Operator dashboard (preview)",
    description: "SLIs, outbox backlog and alert states from D1.",
    badge: "preview",
  },
] as const;

function Home() {
  return (
    <PageContainer>
      <PageHeader
        title="ultra-easy"
        description="Approval workflow platform: ActionRequests are authorized, approved when policy requires it, and then executed."
      />
      <PageSection title="Surfaces">
        <div className="grid gap-4 sm:grid-cols-2">
          {surfaces.map((surface) => (
            <Card key={surface.to}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {surface.title}
                  <Badge variant="secondary">{surface.badge}</Badge>
                </CardTitle>
                <CardDescription>{surface.description}</CardDescription>
              </CardHeader>
              <CardContent />
              <CardFooter>
                <Button asChild variant="outline">
                  <Link to={surface.to}>Open</Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </PageSection>
    </PageContainer>
  );
}
