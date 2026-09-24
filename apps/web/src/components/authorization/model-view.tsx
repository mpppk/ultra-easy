import { CheckCircle2Icon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";

import { PageSection } from "#components/layout/page";
import { ErrorState, LoadingState } from "#components/layout/states";
import { Badge } from "#components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table";
import { adminPath, consoleGet, type AuthorizationModelView } from "#lib/console-client";
import { useConsoleQuery } from "#hooks/use-console-query";

import { CopyableId } from "./copyable-id.tsx";

/**
 * Read-only model inspector. There are deliberately no save / publish /
 * delete / credential / membership controls: the model changes only via Git
 * PR → CI (`fga model test`) → publish.
 */
export function ModelView({ model }: { model: AuthorizationModelView }) {
  return (
    <div data-slot="model-view" className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Active authorization model <Badge variant="secondary">read-only</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="flex items-center gap-2">
            Model ID <CopyableId value={model.activeModelId} label="model id" />
          </p>
          <p>
            Provider <code className="font-mono">{model.provider.apiHost}</code> · store{" "}
            <CopyableId value={model.provider.storeId} label="store id" />
          </p>
          <p className="flex items-center gap-2">
            <GitBranchIcon aria-hidden className="size-4" /> Git source{" "}
            <code className="font-mono">{model.source.path}</code> (tests{" "}
            <code className="font-mono">{model.source.testsPath}</code>)
            {model.source.revision ? (
              <>
                {" "}
                @ <code className="font-mono">{model.source.revision}</code>
              </>
            ) : null}
          </p>
          <p
            className="flex items-center gap-2"
            data-status={model.source.matchesProvider ? "in-sync" : "drift"}
          >
            {model.source.matchesProvider ? (
              <>
                <CheckCircle2Icon aria-hidden className="size-4 text-success" /> Provider model
                matches the Git source
              </>
            ) : (
              <>
                <TriangleAlertIcon aria-hidden className="size-4 text-warning" /> Provider model
                differs from the Git source (publish pending or drift)
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            provider checksum <code>{model.providerChecksum}</code> · source checksum{" "}
            <code>{model.source.checksum}</code>
          </p>
        </CardContent>
      </Card>
      <PageSection title="Types and relations (normalized)">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Relations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.typeDefinitions.map((definition) => (
              <TableRow key={definition.type}>
                <TableCell className="font-mono">{definition.type}</TableCell>
                <TableCell className="font-mono">
                  {definition.relations.join(", ") || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Normalized JSON</summary>
          <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs">
            {JSON.stringify(model.typeDefinitions, null, 2)}
          </pre>
        </details>
      </PageSection>
    </div>
  );
}

export function ModelPage() {
  const model = useConsoleQuery(() => consoleGet<AuthorizationModelView>(adminPath("/model")), []);
  if (model.status === "error") {
    return <ErrorState title="Could not load the authorization model" code={model.error.code} />;
  }
  return model.data ? <ModelView model={model.data} /> : <LoadingState />;
}
