import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleHelpIcon,
  ClockIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SkipForwardIcon,
  XCircleIcon,
} from "lucide-react";
import type * as React from "react";

import { Badge } from "#components/ui/badge";
import { cn } from "#lib/utils";

/**
 * Status vocabulary for the console. Every badge carries an icon and text so
 * meaning never depends on color alone. "Pending"-type states are never
 * labelled as changed/done.
 */
type Tone = "success" | "warning" | "danger" | "info" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/50 bg-warning/15 text-foreground",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-info/40 bg-info/10 text-info",
  muted: "border-border bg-muted text-muted-foreground",
};

function StatusBadge(props: {
  tone: Tone;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  title?: string;
  "data-status"?: string;
}) {
  const Icon = props.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1", TONE_CLASS[props.tone])}
      title={props.title}
      data-status={props["data-status"]}
    >
      <Icon aria-hidden />
      {props.label}
    </Badge>
  );
}

const OUTCOME = {
  deny: { tone: "danger", icon: ShieldXIcon, label: "Denied" },
  allowed_no_approval: { tone: "success", icon: ShieldCheckIcon, label: "Allowed · no approval" },
  allowed_requires_approval: {
    tone: "info",
    icon: ClockIcon,
    label: "Allowed · approval required",
  },
  evaluation_error: {
    tone: "warning",
    icon: AlertTriangleIcon,
    label: "Evaluation error (not evaluated)",
  },
} as const;

export function EffectiveOutcomeBadge({ outcome }: { outcome: keyof typeof OUTCOME }) {
  const config = OUTCOME[outcome];
  return <StatusBadge {...config} data-status={outcome} />;
}

const AUTHORIZATION = {
  allow: { tone: "success", icon: ShieldCheckIcon, label: "FGA allow" },
  deny: { tone: "danger", icon: ShieldXIcon, label: "FGA deny" },
  error: { tone: "warning", icon: AlertTriangleIcon, label: "Provider error" },
  not_evaluated: { tone: "muted", icon: CircleDashedIcon, label: "Not evaluated" },
} as const;

export function AuthorizationOutcomeBadge({ outcome }: { outcome: keyof typeof AUTHORIZATION }) {
  return <StatusBadge {...AUTHORIZATION[outcome]} data-status={outcome} />;
}

const SYNC = {
  prepared: {
    tone: "info",
    icon: ClockIcon,
    label: "Pending sync",
    title: "Intent recorded; not applied to FGA yet",
  },
  applying: {
    tone: "info",
    icon: RefreshCwIcon,
    label: "Applying",
    title: "Being applied to FGA; not confirmed",
  },
  confirmed: {
    tone: "success",
    icon: CheckCircle2Icon,
    label: "Confirmed",
    title: "FGA state observed equal to the desired state",
  },
  indeterminate: {
    tone: "warning",
    icon: CircleHelpIcon,
    label: "Unknown · reconciling",
    title: "FGA effect unknown; reconciliation will converge to the latest desired state",
  },
  failed: {
    tone: "danger",
    icon: XCircleIcon,
    label: "Failed",
    title: "FGA rejected the change; not applied",
  },
  superseded: {
    tone: "muted",
    icon: SkipForwardIcon,
    label: "Superseded",
    title: "A newer change to the same relationship took precedence",
  },
} as const;

export type SyncLikeStatus = keyof typeof SYNC;

export function SyncStatusBadge({ status }: { status: string }) {
  const config = SYNC[status as SyncLikeStatus] ?? {
    tone: "muted" as const,
    icon: CircleDashedIcon,
    label: status,
  };
  return <StatusBadge {...config} data-status={status} />;
}

const REQUEST = {
  evaluating: { tone: "muted", icon: CircleDashedIcon, label: "Evaluating" },
  pending_approval: { tone: "info", icon: ClockIcon, label: "Pending approval" },
  approved: { tone: "info", icon: ClockIcon, label: "Approved · executing" },
  executing: { tone: "info", icon: RefreshCwIcon, label: "Executing" },
  executed: { tone: "success", icon: CheckCircle2Icon, label: "Executed" },
  rejected: { tone: "danger", icon: XCircleIcon, label: "Rejected" },
  cancelled: { tone: "muted", icon: BanIcon, label: "Cancelled" },
  expired: { tone: "muted", icon: BanIcon, label: "Expired" },
  authorization_revoked: { tone: "danger", icon: ShieldXIcon, label: "Authorization revoked" },
  authorization_check_failed: {
    tone: "warning",
    icon: AlertTriangleIcon,
    label: "Authorization check failed",
  },
  execution_failed: { tone: "danger", icon: XCircleIcon, label: "Execution failed" },
} as const;

export function ActionRequestStatusBadge({ status }: { status: string }) {
  const config = REQUEST[status as keyof typeof REQUEST] ?? {
    tone: "muted" as const,
    icon: CircleDashedIcon,
    label: status,
  };
  return <StatusBadge {...config} data-status={status} />;
}

const PHASE = {
  requested: { tone: "info", icon: ClockIcon, label: "Requested" },
  apply_started: { tone: "info", icon: RefreshCwIcon, label: "Apply started" },
  confirmed: { tone: "success", icon: CheckCircle2Icon, label: "Effect confirmed" },
  indeterminate: { tone: "warning", icon: CircleHelpIcon, label: "Indeterminate" },
  superseded: { tone: "muted", icon: SkipForwardIcon, label: "Superseded" },
  failed: { tone: "danger", icon: XCircleIcon, label: "Failed" },
  drift_repaired: { tone: "warning", icon: RefreshCwIcon, label: "Drift repaired" },
} as const;

export function AuditPhaseBadge({ phase }: { phase: keyof typeof PHASE }) {
  return <StatusBadge {...PHASE[phase]} data-status={phase} />;
}
