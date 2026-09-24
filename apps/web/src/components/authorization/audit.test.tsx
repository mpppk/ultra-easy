import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "#components/ui/tooltip";
import type { RelationshipAuditView } from "#lib/console-client";

import { AuditDetail, auditQuery, AuditTable } from "./audit.tsx";

function event(phase: RelationshipAuditView["phase"], sequence: number): RelationshipAuditView {
  const type = {
    requested: "authorization.relationship_change_requested",
    apply_started: "authorization.relationship_apply_started",
    confirmed: "authorization.relationship_change_confirmed",
    indeterminate: "authorization.relationship_change_indeterminate",
    superseded: "authorization.relationship_change_superseded",
    failed: "authorization.relationship_change_failed",
    drift_repaired: "authorization.relationship_drift_repaired",
  }[phase] as RelationshipAuditView["type"];
  return {
    sequence,
    eventKey: `e-${sequence}`,
    type,
    phase,
    occurredAt: "2026-09-24T01:02:03.000Z",
    actor: { type: "user", id: "user:auth0|editor" as never },
    sourceActionRequestId: "action:42",
    mutationKey: "ue:v1:org:action:42",
    tupleKey: "tuple:sha256:1",
    revision: 7,
    operation: "write",
    desiredState: "present",
    subject: "user:auth0|alice",
    relation: "can_execute",
    object: "ticket:T-1",
    providerObject: "ticket:organization%3Astaging/T-1",
    authorizationModelId: "model-1",
    errorCode: phase === "indeterminate" ? "fga_http_503" : null,
  };
}

const render = (node: React.ReactNode) => renderToString(<TooltipProvider>{node}</TooltipProvider>);

describe("Audit UI (AC-M9-009)", () => {
  it("distinguishes requested / confirmed / indeterminate / superseded / failed", () => {
    const html = render(
      <AuditTable
        items={[
          event("requested", 1),
          event("confirmed", 2),
          event("indeterminate", 3),
          event("superseded", 4),
          event("failed", 5),
        ]}
        onSelect={() => undefined}
      />,
    );
    for (const phase of ["requested", "confirmed", "indeterminate", "superseded", "failed"]) {
      expect(html).toContain(`data-phase="${phase}"`);
      expect(html).toContain(`data-status="${phase}"`);
    }
    expect(html).toContain("Effect confirmed");
    expect(html).toContain("Indeterminate");
  });

  it("detail shows actor, time, tuple, source ActionRequest and mutation revision; requested is not proof", () => {
    const html = render(<AuditDetail event={event("requested", 1)} />);
    for (const value of [
      "user:auth0|editor",
      "2026-09-24T01:02:03.000Z",
      "user:auth0|alice",
      "can_execute",
      "ticket:T-1",
      "action:42",
      "ue:v1:org:action:42",
      "revision",
      "model-1",
    ]) {
      expect(html).toContain(value);
    }
    expect(html).toContain("not proof that FGA changed");
    const indeterminate = render(<AuditDetail event={event("indeterminate", 3)} />);
    expect(indeterminate).toContain("unknown");
    expect(indeterminate).not.toContain("Effect confirmed");
  });

  it("builds filter queries without organization parameters", () => {
    expect(
      auditQuery({
        actor: "user:x",
        eventType: "__any__",
        operation: "delete",
        subject: "",
        relation: "",
        object: "ticket:T-1",
        actionRequestId: "",
        mutationKey: "",
        revision: "3",
        from: "",
        to: "",
      }),
    ).toEqual({
      actor: "user:x",
      eventType: undefined,
      operation: "delete",
      subject: undefined,
      relation: undefined,
      object: "ticket:T-1",
      actionRequestId: undefined,
      mutationKey: undefined,
      revision: "3",
      from: undefined,
      to: undefined,
      cursor: undefined,
      limit: "50",
    });
  });
});
