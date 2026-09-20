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
