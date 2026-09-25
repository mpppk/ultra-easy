import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { OrganizationId } from "@app/approval-core";

import {
  countRecentWorkflowFailures,
  listStuckActionRequestCandidates,
} from "./operator-signals.ts";
import { migratedSqliteD1 } from "./testing/sqlite-d1.ts";

const org = "organization:signals" as OrganizationId;
const other = "organization:other" as OrganizationId;

function insertEvent(
  db: ReturnType<typeof migratedSqliteD1>,
  input: { organizationId: string; actionRequestId: string; type: string; occurredAt: string },
) {
  db.db
    .prepare(
      `INSERT INTO action_events (organization_id, action_request_id, event_key, event_type, occurred_at, event_json)
       VALUES (?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      input.organizationId,
      input.actionRequestId,
      `${input.actionRequestId}:${input.type}:${input.occurredAt}`,
      input.type,
      input.occurredAt,
    );
}

function insertProjection(
  db: ReturnType<typeof migratedSqliteD1>,
  input: { actionRequestId: string; status: string; updatedAt: string; organizationId?: string },
) {
  db.db
    .prepare(
      `INSERT INTO approval_runtime_projections
         (organization_id, action_request_id, approval_plan_checksum, status, state_json, updated_at)
       VALUES (?, ?, 'sha256:x', ?, '{}', ?)`,
    )
    .run(input.organizationId ?? org, input.actionRequestId, input.status, input.updatedAt);
}

describe("#109 operator signals", () => {
  it("直近windowのworkflow.failedだけを組織単位で数える", async () => {
    const db = migratedSqliteD1();
    insertEvent(db, {
      organizationId: org,
      actionRequestId: "a1",
      type: "workflow.failed",
      occurredAt: "2026-09-25T00:04:00.000Z",
    });
    insertEvent(db, {
      organizationId: org,
      actionRequestId: "a2",
      type: "workflow.failed",
      occurredAt: "2026-09-24T23:50:00.000Z",
    });
    insertEvent(db, {
      organizationId: org,
      actionRequestId: "a3",
      type: "action.completed",
      occurredAt: "2026-09-25T00:04:30.000Z",
    });
    insertEvent(db, {
      organizationId: other,
      actionRequestId: "a4",
      type: "workflow.failed",
      occurredAt: "2026-09-25T00:04:00.000Z",
    });

    const count = await countRecentWorkflowFailures(db, {
      organizationId: org,
      since: "2026-09-25T00:00:00.000Z",
    });
    expect(count).toEqual(Result.succeed(1));
  });

  it("更新の止まった非終端projectionのうち結果の無いものを古い順に返す", async () => {
    const db = migratedSqliteD1();
    insertProjection(db, {
      actionRequestId: "action:old-pending",
      status: "pending",
      updatedAt: "2026-09-24T20:00:00.000Z",
    });
    insertProjection(db, {
      actionRequestId: "action:old-approved",
      status: "approved",
      updatedAt: "2026-09-24T21:00:00.000Z",
    });
    insertProjection(db, {
      actionRequestId: "action:recent",
      status: "pending",
      updatedAt: "2026-09-25T00:00:00.000Z",
    });
    insertProjection(db, {
      actionRequestId: "action:terminal",
      status: "rejected",
      updatedAt: "2026-09-24T20:00:00.000Z",
    });
    insertProjection(db, {
      actionRequestId: "action:executed",
      status: "approved",
      updatedAt: "2026-09-24T20:00:00.000Z",
    });
    insertProjection(db, {
      actionRequestId: "action:other-org",
      status: "pending",
      updatedAt: "2026-09-24T20:00:00.000Z",
      organizationId: other,
    });
    db.db
      .prepare(
        `INSERT INTO action_results (organization_id, action_request_id, workflow_instance_id, status, completed_at)
         VALUES (?, 'action:executed', 'wf', 'executed', '2026-09-24T20:01:00.000Z')`,
      )
      .run(org);

    const candidates = await listStuckActionRequestCandidates(db, {
      organizationId: org,
      updatedBefore: "2026-09-24T23:45:00.000Z",
      limit: 10,
    });
    assert(Result.isSuccess(candidates));
    expect(candidates.value).toEqual([
      {
        actionRequestId: "action:old-pending",
        projectionStatus: "pending",
        updatedAt: "2026-09-24T20:00:00.000Z",
      },
      {
        actionRequestId: "action:old-approved",
        projectionStatus: "approved",
        updatedAt: "2026-09-24T21:00:00.000Z",
      },
    ]);

    const limited = await listStuckActionRequestCandidates(db, {
      organizationId: org,
      updatedBefore: "2026-09-24T23:45:00.000Z",
      limit: 1,
    });
    assert(Result.isSuccess(limited));
    expect(limited.value.map((candidate) => String(candidate.actionRequestId))).toEqual([
      "action:old-pending",
    ]);
  });
});
