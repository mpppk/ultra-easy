import type { ApprovalStepPresentation, ApprovalTargetPresentation } from "@app/approval-core";

import { CopyableId } from "../authorization/copyable-id.tsx";

export function targetText(target: ApprovalTargetPresentation): string {
  return target.type === "relation"
    ? `${target.relation} of ${target.object}`
    : `user ${target.userId}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Materialized step metadata as recorded in the plan (no runtime progress). */
export function ApprovalStepDetail({ step }: { step: ApprovalStepPresentation }) {
  return (
    <dl data-slot="approval-step-detail" className="divide-y">
      <Row label="Step">
        {step.name ? `${step.name} · ` : ""}
        <code className="font-mono">{step.stepKey}</code>
      </Row>
      <Row label="Purpose">{step.purpose ?? "—"}</Row>
      <Row label="Approver target">
        <span>{targetText(step.target)}</span>{" "}
        <span className="text-muted-foreground">({step.target.sourceKind})</span>
      </Row>
      <Row label="Resolution">{step.resolution}</Row>
      <Row label="Candidates">{step.candidateCompletion.label}</Row>
      {step.selfApproval ? (
        <Row label="Self approval">
          {step.selfApproval.mode}
          {step.selfApproval.subject ? ` (${String(step.selfApproval.subject.id)})` : ""}
        </Row>
      ) : null}
      {step.onUnresolved ? (
        <Row label="If unresolved">
          {step.onUnresolved.type === "fallback"
            ? `fallback to ${targetText(step.onUnresolved.target)}`
            : "deny"}
        </Row>
      ) : null}
      {step.expiresAfterSeconds !== undefined ? (
        <Row label="Expires after">{step.expiresAfterSeconds}s</Row>
      ) : null}
      {step.requireCommentOn?.length ? (
        <Row label="Comment required">{step.requireCommentOn.join(", ")}</Row>
      ) : null}
      <Row label="Source policy">
        <code className="font-mono">{step.source.policyKey}</code> v{step.source.policyVersion}
      </Row>
      <Row label="Binding">
        <CopyableId value={step.source.policyBindingId} label="binding id" />
      </Row>
      <Row label="Matched rule">{step.source.matchedRuleKey ?? "—"}</Row>
      <Row label="Flow path">
        <code className="font-mono">{step.source.flowPath}</code>
      </Row>
      <Row label="Materialized step">
        <CopyableId value={step.materializedStepId} label="materialized step id" />
      </Row>
    </dl>
  );
}
