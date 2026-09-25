import { Button } from "#components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#components/ui/dialog";
import { SENSITIVITY_LABEL, VISIBILITY_LABEL } from "#lib/format";

import type { PageView } from "../../shared/api.ts";

/** Confirms the exact values the immutable PublicationSnapshot will pin. */
export function PublishDialog({
  open,
  onOpenChange,
  next,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  next: NonNullable<PageView["nextPublication"]>;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this revision?</DialogTitle>
          <DialogDescription>
            These values are fixed in an immutable publication snapshot. Later draft edits do not
            change it.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Revision</dt>
          <dd>
            #{next.revisionNumber}
            {next.reusesRevision ? (
              <span className="text-muted-foreground"> (existing, unchanged content)</span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Visibility</dt>
          <dd>{VISIBILITY_LABEL[next.visibility]}</dd>
          <dt className="text-muted-foreground">Sensitivity</dt>
          <dd>{SENSITIVITY_LABEL[next.sensitivity]}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">
          ultra-easy decides whether approval is required for these settings.
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
