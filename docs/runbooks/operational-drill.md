# M7 production-readiness drill

Issue: #58 / parent #51

This document separates automated evidence from the staging exercise that must be recorded before M7 is considered operationally complete.

## Automated evidence

The normal repository check runs:

- `tests/acceptance/m6-critical-path.test.ts`: all 15 M6 critical-path cases;
- `packages/approval-runtime-cloudflare/src/workflow.integration.test.ts`: real Cloudflare Workflows/D1 integration, including the AC-M7-010 stuck-request force-cancel recovery path;
- `packages/approval-d1/src/operational-recovery.integration.test.ts`: forward migration and backup/restore invariants.

The AC-M7-010 integration drill demonstrates:

1. a pending ActionRequest can be located by its organization + correlation ID;
2. its persisted runtime state is observed as pending;
3. `admin.force_cancel` terminates the Workflow;
4. the runtime projection becomes `cancelled`;
5. append-only audit contains `action.completed(result=cancelled)`;
6. force-cancel audit retains actor, reason, time and `postReviewRequired=true`.

## Staging evidence template

Record one production-equivalent exercise here or in the linked incident/change ticket before closing #58.

- Date/time:
- Environment / D1 database:
- Release commit:
- Operator:
- Organization:
- Target ActionRequest / correlation ID:
- Initial Workflow status:
- Latest event before recovery:
- Force-cancel governance ActionRequest ID:
- Final projection status:
- Final `action.completed` event:
- Force-cancel audit verified:
- `postReviewRequired=true` verified:
- Backup/recovery-point identifier:
- Restore validation result:
- Queue/DLQ recovery result:
- OpenFGA/provider outage result:
- M6 15-case suite result:
- Follow-up / post-review link:

Do not mark the staging section complete from CI results alone.

## Staging evidence — 2026-09-21 drill (#58)

Exercised through the preview drill endpoint
`POST /preview/approval-runs/:id/force-cancel`, which runs the production
`GovernanceActionExecutor` + `CloudflareWorkflowCancellationControl` path
(`admin.force_cancel`) against the staging Workflows + D1.

- Date/time: 2026-09-21T06:32:25Z (stop point) → 2026-09-21T06:32:36Z (recovered)
- Environment / D1 database: branch preview web + stable runtime
  `ultra-easy-approval-runtime-preview` version `6d8d5bb3`,
  D1 `ad6f0cd7-ab10-40f0-bc8b-5ff251ae350f` (migrations 0001–0010 applied)
- Release commit: `af934e9` (on top of `57c907d`, PR #65 merged)
- Operator: `user:drill-operator`
- Organization: `organization:preview`
- Target ActionRequest / correlation ID:
  `preview-serial-two-users-c8839def-56c0-4723-b5b8-42f3f130f02e`
- Initial Workflow status: `running`; runtime projection `pending`
  (manager task pending for `user:alice`)
- Latest event before recovery: `step.activated` at 2026-09-21T06:32:25.680Z
- Force-cancel governance ActionRequest ID:
  `preview-force-cancel:preview-serial-two-users-c8839def-56c0-4723-b5b8-42f3f130f02e`
- Final projection status: `cancelled` (task `cancelled`, `completedAt` set)
- Final `action.completed` event: `action.completed(result=cancelled)`
  at 2026-09-21T06:32:36.615Z
- Force-cancel audit verified: actor `user:drill-operator`, reason
  `M7 staging operational drill (#58): stuck request recovery verification (final)`,
  occurredAt 2026-09-21T06:32:36.615Z
- `postReviewRequired=true` verified: yes (`post_review_required=1` in audit row)
- Backup/recovery-point identifier: no new migration in this change;
  remote D1 carries migrations 0001–0010, verified by deploy-time apply
- Restore validation result: covered by
  `packages/approval-d1/src/operational-recovery.integration.test.ts` (CI green)
- Queue/DLQ recovery result: covered by
  `packages/approval-runtime-cloudflare/src/notifications.integration.test.ts`
  (CI green); no live DLQ incident was injected in this drill
- OpenFGA/provider outage result: preview OpenFGA vars are inert placeholders
  by design; fail-closed behavior covered by authorization contract/integration
  tests (CI green)
- M6 15-case suite result: `tests/acceptance/m6-critical-path.test.ts` 15/15 green
  on the release candidate
- Follow-up / post-review link: #58

Safety matrix also verified on staging: empty reason → 400, unknown run → 404,
force-cancel on approved/executed run → 409 `force_cancel_target_not_pending`,
replay with a different reason on a cancelled run → 409
`force_cancel_audit_conflict`. No external executor side effect fires after
cancellation (preview executor is a no-op sink; production path is unchanged).
