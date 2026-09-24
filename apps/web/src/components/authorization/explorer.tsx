import { PlayIcon } from "lucide-react";
import { useId, useState } from "react";

import { ApprovalFlowView } from "#components/approval/approval-flow-view";
import { PageSection, Toolbar } from "#components/layout/page";
import { ErrorState } from "#components/layout/states";
import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import { Button } from "#components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#components/ui/card";
import { Input } from "#components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table";
import { Textarea } from "#components/ui/textarea";
import {
  adminPath,
  ConsoleApiError,
  consolePost,
  type AuthorizationExplainResult,
  type ConsoleCatalog,
} from "#lib/console-client";

import { CopyableId } from "./copyable-id.tsx";
import { AuthorizationOutcomeBadge, EffectiveOutcomeBadge } from "./status-badges.tsx";

export type ExplorerFormValue = {
  principalType: "user" | "agent" | "service";
  principalId: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  input: string;
  overrides: string;
};

export type ExplainRequestBody = {
  principal: { type: string; id: string };
  action: { type: string; resource: { type: string; id: string }; input?: unknown };
  simulationOverrides?: Record<string, unknown>;
};

/**
 * Builds the explain request. `action.input` is sent as the complete JSON the
 * user typed (or omitted when empty) so that the server performs the real
 * schema validation; browser-side parsing only catches JSON syntax.
 */
export function explainRequestBody(
  value: ExplorerFormValue,
): { body: ExplainRequestBody } | { error: string } {
  let input: unknown;
  if (value.input.trim()) {
    try {
      input = JSON.parse(value.input);
    } catch {
      return { error: "action.input is not valid JSON" };
    }
  }
  let overrides: Record<string, unknown> | undefined;
  if (value.overrides.trim()) {
    try {
      overrides = JSON.parse(value.overrides) as Record<string, unknown>;
    } catch {
      return { error: "simulation overrides are not valid JSON" };
    }
  }
  return {
    body: {
      principal: { type: value.principalType, id: value.principalId.trim() },
      action: {
        type: value.actionType.trim(),
        resource: { type: value.resourceType.trim(), id: value.resourceId.trim() },
        ...(input !== undefined ? { input } : {}),
      },
      ...(overrides ? { simulationOverrides: overrides } : {}),
    },
  };
}

export function ExplorerForm({
  catalog,
  busy,
  onSubmit,
}: {
  catalog: ConsoleCatalog | undefined;
  busy: boolean;
  onSubmit: (body: ExplainRequestBody) => void;
}) {
  const id = useId();
  const [value, setValue] = useState<ExplorerFormValue>({
    principalType: "user",
    principalId: "",
    actionType: "ticket.update",
    resourceType: "ticket",
    resourceId: "",
    input: '{\n  "ticketId": ""\n}',
    overrides: "",
  });
  const [formError, setFormError] = useState<string>();
  const set = (patch: Partial<ExplorerFormValue>) =>
    setValue((current) => ({ ...current, ...patch }));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const built = explainRequestBody(value);
        if ("error" in built) {
          setFormError(built.error);
          return;
        }
        setFormError(undefined);
        onSubmit(built.body);
      }}
    >
      <Toolbar>
        <label className="flex flex-col gap-1 text-sm">
          Simulated principal type
          <Select
            value={value.principalType}
            onValueChange={(principalType) =>
              set({ principalType: principalType as ExplorerFormValue["principalType"] })
            }
          >
            <SelectTrigger className="w-32" aria-label="Simulated principal type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">user</SelectItem>
              <SelectItem value="agent">agent</SelectItem>
              <SelectItem value="service">service</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
          Simulated principal ID (stable ID, not email)
          <Input
            required
            placeholder="user:auth0|…"
            value={value.principalId}
            onChange={(event) => set({ principalId: event.target.value })}
          />
        </label>
      </Toolbar>
      <Toolbar>
        <label className="flex min-w-56 flex-col gap-1 text-sm">
          Action type
          <Input
            required
            list={`${id}-action-types`}
            value={value.actionType}
            onChange={(event) => set({ actionType: event.target.value })}
          />
          <datalist id={`${id}-action-types`}>
            {catalog?.actionTypes.map((entry) => (
              <option key={entry.actionType} value={entry.actionType} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Resource type
          <Input
            required
            value={value.resourceType}
            onChange={(event) => set({ resourceType: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Resource ID
          <Input
            required
            value={value.resourceId}
            onChange={(event) => set({ resourceId: event.target.value })}
          />
        </label>
      </Toolbar>
      <label className="flex flex-col gap-1 text-sm">
        action.input (JSON) — validated on the server with the Action Definition schema
        <Textarea
          className="min-h-32 font-mono text-xs"
          value={value.input}
          onChange={(event) => set({ input: event.target.value })}
        />
      </label>
      {catalog?.simulationOverrides.length ? (
        <label className="flex flex-col gap-1 text-sm">
          Simulation overrides (JSON; allowed: {catalog.simulationOverrides.join(", ")})
          <Textarea
            className="min-h-16 font-mono text-xs"
            value={value.overrides}
            onChange={(event) => set({ overrides: event.target.value })}
          />
        </label>
      ) : null}
      {formError ? <ErrorState title={formError} /> : null}
      <div>
        <Button type="submit" disabled={busy}>
          <PlayIcon aria-hidden /> Evaluate (no side effects)
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function ExplorerResult({ result }: { result: AuthorizationExplainResult }) {
  return (
    <div data-slot="explorer-result" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <EffectiveOutcomeBadge outcome={result.effectiveOutcome} />
        <span className="text-sm text-muted-foreground">evaluated at {result.evaluatedAt}</span>
      </div>

      {result.effectiveOutcome === "evaluation_error" ? (
        <Alert variant="destructive">
          <AlertTitle>Not evaluated — this is not “no approval required”</AlertTitle>
          <AlertDescription>
            <p>
              code <code className="font-mono">{result.error?.code}</code>: {result.error?.message}
            </p>
            {result.error?.issues?.length ? (
              <ul className="list-disc pl-5">
                {result.error.issues.map((issue, index) => (
                  <li key={index}>
                    {issue.path ? <code className="font-mono">{issue.path}</code> : null}{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Authorization <AuthorizationOutcomeBadge outcome={result.authorization.outcome} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Console caller">
                <CopyableId value={String(result.caller.id)} label="caller" />
              </Field>
              <Field label="Simulated principal">
                <CopyableId
                  value={String(result.simulatedPrincipal.id)}
                  label="simulated principal"
                />{" "}
                <span className="text-muted-foreground">({result.simulatedPrincipal.type})</span>
              </Field>
              <Field label="Relation">{result.authorization.relation ?? "— (unmapped)"}</Field>
              <Field label="Object">{result.authorization.logicalObject ?? "—"}</Field>
              <Field label="Consistency">{result.authorization.consistency}</Field>
              <Field label="Model ID">{result.authorization.authorizationModelId ?? "—"}</Field>
              {result.authorization.code ? (
                <Field label="Deny code">
                  <code className="font-mono">{result.authorization.code}</code>
                </Field>
              ) : null}
            </dl>
            {result.authorization.providerObject ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Provider-scoped object (details)
                </summary>
                <CopyableId value={result.authorization.providerObject} label="provider object" />
              </details>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              OpenFGA does not return proof paths; why a relation holds is not shown.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Action</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Type">{result.action.type}</Field>
              <Field label="Resource">
                {result.action.resource.type}:{result.action.resource.id}
              </Field>
            </dl>
            {result.normalizedInput !== null ? (
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(result.normalizedInput, null, 2)}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {result.applicablePolicies.length > 0 ? (
        <PageSection title="Applicable policies">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Binding</TableHead>
                <TableHead>Policy</TableHead>
                <TableHead>Matched rule</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.applicablePolicies.map((policy) => (
                <TableRow key={policy.bindingId}>
                  <TableCell>{policy.bindingId}</TableCell>
                  <TableCell>
                    {policy.policyKey} v{policy.policyVersion}
                  </TableCell>
                  <TableCell>{policy.matchedRuleKey ?? "—"}</TableCell>
                  <TableCell>
                    {policy.outcome === "flow" ? "approval flow" : "no approval"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PageSection>
      ) : null}

      {result.approvalFlow ? (
        <PageSection title="Simulation approval flow">
          <ApprovalFlowView flow={result.approvalFlow} />
        </PageSection>
      ) : null}
    </div>
  );
}

export function ExplorerPage({ catalog }: { catalog: ConsoleCatalog | undefined }) {
  const [result, setResult] = useState<AuthorizationExplainResult>();
  const [error, setError] = useState<ConsoleApiError>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <PageSection
        title="Access Explorer"
        description="Evaluate a complete Action for a principal through the real ActionRequest evaluation path. No ActionRequest, workflow or execution is created."
      >
        <ExplorerForm
          catalog={catalog}
          busy={busy}
          onSubmit={(body) => {
            setBusy(true);
            setError(undefined);
            consolePost<AuthorizationExplainResult>(adminPath("/explain"), body)
              .then(setResult, (caught: unknown) =>
                setError(
                  caught instanceof ConsoleApiError
                    ? caught
                    : new ConsoleApiError(0, "network_error", String(caught)),
                ),
              )
              .finally(() => setBusy(false));
          }}
        />
      </PageSection>
      {error ? <ErrorState title="Explain request failed" code={error.code} /> : null}
      {result ? <ExplorerResult result={result} /> : null}
    </div>
  );
}
