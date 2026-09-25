import { createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { RolePill } from "#components/knowledge/badges";
import { AppLink } from "#components/layout/app-link";
import { Breadcrumbs, PageContainer, PageHeader } from "#components/layout/page";
import { LoadingState, QueryError } from "#components/layout/states";
import { Button } from "#components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import { Switch } from "#components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#components/ui/tabs";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";
import { relativeTime } from "#lib/format";

import type { ApprovalRuleView, SpaceSettingsView } from "../shared/api.ts";

export const Route = createFileRoute("/_app/spaces/$spaceKey/settings")({
  component: SpaceSettings,
});

const APPROVER_LABEL = { space_owners: "Space owners", page_owner: "Page owner" } as const;

/**
 * Post-MVP screen 8. A thin, domain-specific editor over presets: saving
 * compiles them server-side into an ultra-easy policy binding and goes through
 * the governed `approval_policy_binding.update` path (meta-approval).
 */
function SpaceSettings() {
  const { spaceKey } = Route.useParams();
  const settings = useApiQuery(
    () => apiGet<SpaceSettingsView>(`/api/spaces/${encodeURIComponent(spaceKey)}/settings`),
    [spaceKey],
  );
  if (settings.status === "error")
    return <QueryError error={settings.error} onRetry={settings.refetch} />;
  if (!settings.data) {
    return (
      <PageContainer>
        <LoadingState rows={2} />
      </PageContainer>
    );
  }
  return (
    <SettingsForm
      key={settings.data.policyVersion}
      data={settings.data}
      onSaved={settings.refetch}
    />
  );
}

function SettingsForm({ data, onSaved }: { data: SpaceSettingsView; onSaved: () => void }) {
  const [rules, setRules] = useState<ApprovalRuleView[]>(data.rules);
  const mutation = useMutation();
  const dirty = JSON.stringify(rules) !== JSON.stringify(data.rules);
  const update = (key: ApprovalRuleView["key"], change: Partial<ApprovalRuleView>) =>
    setRules((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...change } : rule)),
    );
  return (
    <PageContainer>
      <Breadcrumbs
        items={[
          { label: "Spaces", href: "/spaces" },
          { label: data.space.name, href: `/spaces/${data.space.key}` },
          { label: "Settings" },
        ]}
      />
      <PageHeader
        title={`${data.space.name} — Settings`}
        badge={<RolePill role={data.space.role} />}
        description="Manage approval rules, team permissions, and space attributes."
      />
      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members / Access</TabsTrigger>
          <TabsTrigger value="rules">Approval Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="mt-4">
          <dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-y-3 rounded-xl border bg-card p-5 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{data.space.name}</dd>
            <dt className="text-muted-foreground">Key</dt>
            <dd className="font-mono">{data.space.key}</dd>
            <dt className="text-muted-foreground">Description</dt>
            <dd>{data.space.description || "—"}</dd>
            <dt className="text-muted-foreground">Published pages</dt>
            <dd>{data.space.publishedPageCount}</dd>
            <dt className="text-muted-foreground">Last activity</dt>
            <dd>{data.space.lastActivityAt ? relativeTime(data.space.lastActivityAt) : "—"}</dd>
          </dl>
        </TabsContent>
        <TabsContent value="members" className="mt-4">
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
            <ul className="flex flex-col divide-y">
              {data.members.map((member) => (
                <li
                  key={member.principal.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <span>
                    {member.principal.displayName}{" "}
                    <span className="text-xs text-muted-foreground">{member.principal.id}</span>
                  </span>
                  <RolePill role={member.role} />
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Memberships are ultra-easy authorization relationships. Manage them in{" "}
              <a href={data.adminUrl} className="text-primary hover:underline">
                ultra-easy Admin
              </a>
              .
            </p>
          </div>
        </TabsContent>
        <TabsContent value="rules" className="mt-4 flex flex-col gap-4">
          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold">Approval Workflows</h2>
            <p className="text-sm text-muted-foreground">
              Define when specific publication paths or page actions require validation before going
              live.
            </p>
            <ul className="mt-4 flex flex-col divide-y">
              {rules.map((rule) => (
                <li
                  key={rule.key}
                  className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">{rule.title}</p>
                    <p className="text-xs text-muted-foreground">{rule.description}</p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <label className="flex items-center gap-2">
                      Require approval
                      <Switch
                        checked={rule.requireApproval}
                        onCheckedChange={(checked) =>
                          update(rule.key, { requireApproval: checked })
                        }
                        aria-label={`Require approval: ${rule.title}`}
                      />
                    </label>
                    <span className="flex items-center gap-2">
                      Approver
                      <Select
                        value={rule.approver}
                        onValueChange={(value) =>
                          update(rule.key, { approver: value as ApprovalRuleView["approver"] })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-36"
                          aria-label={`Approver: ${rule.title}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(["space_owners", "page_owner"] as const).map((approver) => (
                            <SelectItem key={approver} value={approver}>
                              {APPROVER_LABEL[approver]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="border-t pt-4 text-xs text-muted-foreground">
              For advanced approval policies, visit{" "}
              <a
                href={data.adminUrl}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                ultra-easy Admin <ArrowRightIcon className="size-3" />
              </a>
            </p>
          </div>
          {mutation.error ? (
            <p className="text-sm text-destructive">{mutation.error.title}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={!dirty || mutation.busy}
              onClick={() =>
                void mutation
                  .run(() =>
                    apiSend("PUT", `/api/spaces/${data.space.key}/settings/approval-rules`, {
                      rules: rules.map(({ key, requireApproval, approver }) => ({
                        key,
                        requireApproval,
                        approver,
                      })),
                    }),
                  )
                  .then((saved) => saved && onSaved())
              }
            >
              Save changes
            </Button>
            <Button variant="outline" disabled={!dirty} onClick={() => setRules(data.rules)}>
              Cancel
            </Button>
          </div>
          {data.pendingChange ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/40 bg-info/10 p-4">
              <div>
                <p className="text-sm font-semibold">Policy update pending approval</p>
                <p className="text-xs text-muted-foreground">
                  Changes to approval rules are waiting for review before they can be applied to
                  this space.
                </p>
              </div>
              <Button asChild>
                <a href={data.pendingChange.approvalUrl}>
                  View approval <ExternalLinkIcon />
                </a>
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Policy binding version{" "}
            {data.policyVersion === 0 ? "seed (default)" : data.policyVersion}.{" "}
            <AppLink href={`/spaces/${data.space.key}`} className="text-primary hover:underline">
              Back to space
            </AppLink>
          </p>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
