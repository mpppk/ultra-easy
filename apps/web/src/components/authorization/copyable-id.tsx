import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "#components/ui/button";
import { cn } from "#lib/utils";

/** Raw stable identifiers are always visible in monospace and copyable. */
export function CopyableId({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1", className)}>
      <code className="truncate rounded bg-muted px-1 py-0.5 font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={`Copy ${label ?? "id"}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </Button>
    </span>
  );
}
