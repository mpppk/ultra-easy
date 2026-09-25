import type { Sensitivity, Visibility } from "@app/knowledge-core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff)) return "";
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Private",
  space: "Space",
  organization: "Organization",
};

export const VISIBILITY_HELP: Record<Visibility, string> = {
  private: "Only you and space owners can read the published page.",
  space: "Visible to members of this space.",
  organization: "Visible to all registered members in your workspace.",
};

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  normal: "Normal",
  internal: "Internal",
  confidential: "Confidential",
};

export function initials(name: string): string {
  return name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function greeting(date: Date = new Date()): string {
  const hour = date.getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
