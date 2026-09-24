import { useEffect, useState } from "react";

import type { ApprovalFlowPresentation, ApprovalStepPresentation } from "@app/approval-core";

import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#components/ui/sheet";

import { ApprovalFlowGraphView } from "./approval-flow-graph-view.tsx";
import { ApprovalFlowTree } from "./approval-flow-tree.tsx";
import { ApprovalStepDetail } from "./approval-step-detail.tsx";

/**
 * Simulation Approval Flow: renders the Materialized Approval Plan faithfully
 * (graph on wide screens, accessible tree always). It is not runtime progress:
 * no approver decisions or active/waiting states are shown.
 */
export function ApprovalFlowView({ flow }: { flow: ApprovalFlowPresentation }) {
  const [selected, setSelected] = useState<ApprovalStepPresentation | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <section data-slot="approval-flow-view" className="flex flex-col gap-3">
      <Alert>
        <AlertTitle>Simulation — Materialized Approval Plan</AlertTitle>
        <AlertDescription>
          The approval route this Action would take if submitted now ({flow.stepCount} step
          {flow.stepCount === 1 ? "" : "s"}). This is not the progress of an existing ActionRequest.
        </AlertDescription>
      </Alert>
      {flow.requiresApproval && mounted ? (
        <div className="hidden md:block">
          <ApprovalFlowGraphView
            flow={flow}
            {...(selected ? { selectedPath: selected.path } : {})}
            onSelect={setSelected}
          />
        </div>
      ) : null}
      <ApprovalFlowTree
        root={flow.root}
        {...(selected ? { selectedPath: selected.path } : {})}
        onSelect={setSelected}
      />
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Approval step</SheetTitle>
            <SheetDescription>Materialized step metadata (simulation).</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {selected ? <ApprovalStepDetail step={selected} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
