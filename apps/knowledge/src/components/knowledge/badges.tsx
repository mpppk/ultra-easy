import type * as React from "react";

import { cn } from "#lib/utils";

import type { PageBadge, StepStatus } from "../../shared/api.ts";

type Tone = "success" | "warning" | "info" | "danger" | "neutral";

const TONE: Record<Tone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  danger: "bg-destructive/10 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

export function Pill({
  tone = "neutral",
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      data-slot="pill"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

const PAGE_BADGE: Record<PageBadge, { tone: Tone; label: string }> = {
  published: { tone: "success", label: "Published" },
  draft: { tone: "neutral", label: "Draft" },
  draft_changes: { tone: "info", label: "Draft changes" },
  needs_review: { tone: "warning", label: "Needs review" },
  archived: { tone: "neutral", label: "Archived" },
  pending_approval: { tone: "warning", label: "Pending approval" },
};

export function PageBadgePill({ badge }: { badge: PageBadge }) {
  const { tone, label } = PAGE_BADGE[badge];
  return <Pill tone={tone}>{label}</Pill>;
}

const STEP: Record<StepStatus, { tone: Tone; label: string }> = {
  done: { tone: "success", label: "Done" },
  running: { tone: "info", label: "Running" },
  waiting: { tone: "warning", label: "Waiting" },
  pending: { tone: "neutral", label: "Pending" },
  failed: { tone: "danger", label: "Failed" },
  conflict: { tone: "danger", label: "Conflict" },
  skipped: { tone: "neutral", label: "Skipped" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function StepPill({ status }: { status: StepStatus }) {
  const { tone, label } = STEP[status];
  return (
    <Pill tone={tone} className="w-16 justify-center">
      {label}
    </Pill>
  );
}

export function TagPill({ children }: { children: React.ReactNode }) {
  return <Pill tone="neutral">{children}</Pill>;
}

export function RolePill({ role }: { role: string }) {
  return <Pill tone="neutral">{role.charAt(0).toUpperCase() + role.slice(1)}</Pill>;
}

export function statusTone(status: string): Tone {
  if (status === "succeeded" || status === "recovered") return "success";
  if (status === "failed" || status === "rejected") return "danger";
  if (status.startsWith("waiting")) return "warning";
  if (status === "running") return "info";
  return "neutral";
}
