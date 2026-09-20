# Dependency outage recovery

Issue: #58

Use this runbook for OpenFGA/provider outages, ActionExecutor dependency failures, Cloudflare Workflow degradation, notification Queue/DLQ incidents, or sustained outbox backlog.

## General response

1. Identify impacted organizations and the first/last affected ActionRequest correlation IDs.
2. Confirm whether the failure is authorization, execution, Workflow, or notification-only.
3. Stop risky mutations if authorization or execution correctness is uncertain.
4. Prefer natural retry for retriable failures; do not manually mark requests successful.
5. After recovery, verify the append-only event stream and relevant SLI counters.

## OpenFGA / authorization provider

Authorization is fail-closed. During provider failure, requests must not be converted into approvals or executions based on stale guesses.

After provider recovery:

- verify `fga.error_total` stops increasing;
- verify Check/ListUsers latency returns to baseline;
- retry only requests whose business intent is still valid;
- force cancel requests whose authority or context may have become stale.

## ActionExecutor/provider outage

For retriable executor failures, allow Workflow retry to reuse the same execution idempotency key. For non-retriable failures, keep the terminal `execution_failed` result; do not replay manually unless the external system's idempotency guarantee is understood.

Before retrying an ambiguous external failure, determine whether the side effect may already have happened.

## Notification Queue / DLQ

Notification delivery is at-least-once. Recovery must preserve the stable logical notification key so a successful recipient delivery is not duplicated.

When messages reach the DLQ:

1. fix the underlying sink/provider problem;
2. inspect outbox and delivery status by organization and notification key;
3. replay DLQ messages without changing their logical delivery keys;
4. verify failed/backlog counts return to normal;
5. do not delete failed rows as a substitute for recovery.

Notification failure does not authorize changing the underlying Action state.

## Outbox backlog

Use `outbox.backlog` and `outbox.failure_total` to determine whether dispatch is stalled. Restore Queue/provider health, then let the dispatcher drain pending/failed work. Escalate if backlog growth continues after recovery.

## Workflow retry/stuck cases

A request that remains non-terminal after dependency recovery should be handled with `stuck-action-request.md`. The operator must verify the stop point from domain events before using `admin.force_cancel`.
