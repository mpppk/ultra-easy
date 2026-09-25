import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";

import { StepPill } from "#components/knowledge/badges";
import { Button } from "#components/ui/button";
import { useMutation } from "#hooks/use-api-query";
import { apiSend } from "#lib/api-client";
import { SENSITIVITY_LABEL, VISIBILITY_LABEL, relativeTime } from "#lib/format";
import { cn } from "#lib/utils";

import type { PublicationPanelView } from "../../shared/api.ts";

const STATE_TEXT: Record<PublicationPanelView["state"], string> = {
  analyzing: "Analyzing",
  waiting_approval: "Waiting for approval",
  publishing: "Publishing",
  published: "Published",
  published_effect_failed: "Published · post-publish automation failed",
  conflict: "Publication conflict",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed_before_publish: "Failed before publish",
};

export const EFFECT_ACTION: Record<"search_reindex" | "watcher_notification", string> = {
  search_reindex: "Retry search index",
  watcher_notification: "Retry notification",
};

/**
 * Domain result (Knowledge: published / conflict, effect ledger) and automation
 * result (ultra-easy run steps) shown side by side. Approve / Reject is never
 * offered here: `View approval` deep-links to ultra-easy.
 */
export function PublicationPanel({
  publication,
  onChanged,
}: {
  publication: PublicationPanelView;
  onChanged: () => void;
}) {
  const mutation = useMutation();
  const retry = (effect: "search_reindex" | "watcher_notification") =>
    mutation
      .run(() =>
        apiSend("POST", `/api/publications/${publication.snapshotId}/effects/${effect}/retry`),
      )
      .then(onChanged);
  const cancel = () =>
    mutation
      .run(() => apiSend("POST", `/api/publications/${publication.snapshotId}/cancel`))
      .then(onChanged);
  const waiting = publication.state === "waiting_approval";

  return (
    <div
      data-slot="publication-panel"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <div className="text-sm">
        <p className="font-semibold">
          {publication.state === "published" || publication.state === "published_effect_failed"
            ? `Published revision #${publication.revisionNumber}`
            : `Revision #${publication.revisionNumber}`}
        </p>
        <p className="text-xs text-muted-foreground">
          {STATE_TEXT[publication.state]} · {VISIBILITY_LABEL[publication.visibility]} ·{" "}
          {SENSITIVITY_LABEL[publication.sensitivity]}
        </p>
        <p className="text-xs text-muted-foreground">
          Requested by {publication.createdBy.displayName} {relativeTime(publication.createdAt)}
        </p>
      </div>
      <ol className="flex flex-col gap-2" aria-label="Publication steps">
        {publication.steps.map((step) => (
          <li key={step.key} className="flex items-start gap-3 text-sm">
            <StepPill status={step.status} />
            <span className="flex flex-col">
              <span className={cn(step.status === "failed" && "text-destructive")}>
                {step.label}
              </span>
              {step.detail && step.status !== "failed" ? (
                <span className="text-xs text-muted-foreground">{step.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
        {publication.steps.length === 0 ? (
          <li className="text-xs text-muted-foreground">
            Automation status is unavailable right now.
          </li>
        ) : null}
      </ol>
      {publication.conflict ? (
        <div className="rounded-lg bg-warning/10 p-3 text-sm" role="status">
          <p className="font-semibold text-warning">Publication conflict</p>
          <p className="text-muted-foreground">
            {publication.conflict.reason === "archived"
              ? "The page was archived before this publication could be applied."
              : `This publication is outdated because the page lifecycle changed (expected ${publication.conflict.expected}, actual ${publication.conflict.actual}).`}
          </p>
          <Button variant="link" className="h-auto p-0" onClick={onChanged}>
            View latest page state
          </Button>
        </div>
      ) : null}
      {publication.failure ? (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm" role="alert">
          <p className="font-semibold text-destructive">Failure</p>
          <p className="text-destructive">{publication.failure.message}</p>
        </div>
      ) : null}
      {mutation.error ? <p className="text-xs text-destructive">{mutation.error.title}</p> : null}
      <div className="flex flex-wrap gap-2">
        {publication.approvalUrl && (waiting || publication.state !== "published") ? (
          <Button asChild size="sm" variant={waiting ? "default" : "outline"}>
            <a href={publication.approvalUrl}>
              View approval <ExternalLinkIcon />
            </a>
          </Button>
        ) : null}
        {publication.retryableEffects.map((effect) => (
          <Button
            key={effect}
            size="sm"
            variant="outline"
            disabled={mutation.busy}
            onClick={() => void retry(effect)}
          >
            <RotateCwIcon /> {EFFECT_ACTION[effect]}
          </Button>
        ))}
        {publication.canCancel ? (
          <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={() => void cancel()}>
            Cancel publication
          </Button>
        ) : null}
      </div>
    </div>
  );
}
