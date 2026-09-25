# Stuck ActionRequest recovery

Issue: #58 / AC-M7-010

Use this runbook when an ActionRequest remains pending longer than its operational SLA, a Workflow is stuck after retries, or an operator must terminate an unsafe in-flight request.

## Safety rules

- Always scope every lookup by both `organizationId` and `actionRequestId`.
- Treat `actionRequestId` as the correlation root, not as an authorization credential.
- Never edit `approval_runtime_projections`, `action_events`, or `force_cancel_audit` directly to manufacture a successful state.
- There is no force-approve path. Recovery is `admin.force_cancel` only.
- A force cancel requires a human-readable reason and produces `postReviewRequired=true`.
- Force cancel claims the cancellation in D1 first (#89): it compare-and-sets the runtime
  projection (`approval_runtime_projections.version`) from `pending` to `cancelled`, then
  terminates the Workflow best-effort. If the Workflow already recorded a decision / reached
  `approved`, the CAS loses and the cancel returns `force_cancel_target_not_pending` — an
  approved or executing request is never recorded as `cancelled`. If `terminate()` fails, the
  Workflow detects the cancellation at its next projection write (CAS conflict) and finishes as
  `cancelled` without applying the decision or executing the action.

## 1. Identify the request

Start from the alert/log correlation ID and establish the tenant first. Query the runtime projection and append-only events using the same organization scope.

Confirm:

1. the ActionRequest belongs to the expected organization;
2. the projection is non-terminal, normally `pending`;
3. the latest domain event identifies the stop point;
4. the Workflow has not already completed successfully.

The minimum evidence to record in the incident is:

- organization ID
- ActionRequest ID / correlation ID
- current projection status
- latest event type and timestamp
- Workflow status
- operator identity
- incident/ticket reference

## 2. Determine whether to retry or cancel

Retry/recover the dependency first when the request is healthy and the failure is clearly transient. Use force cancel when the request cannot safely make progress, when its authority is no longer valid, or when the incident commander requires termination.

Do not force cancel a request merely to bypass approval or authorization.

## 3. Submit `admin.force_cancel`

Submit a normal governance ActionRequest through the trusted Public API path. The transport must supply the operator actor/authority; do not put trusted identity fields in the request body.

The Action input is logically:

```json
{
  "type": "admin.force_cancel",
  "input": {
    "targetActionRequestId": "<stuck-action-request-id>",
    "reason": "<incident reason>"
  }
}
```

The governance executor terminates the Cloudflare Workflow first, then atomically writes the cancelled runtime projection plus `action.completed(result=cancelled)`. Replays are idempotent.

## 4. Verify recovery

Verify all of the following before closing the incident:

- runtime projection is `cancelled`;
- the append-only event stream ends with `action.completed` / `cancelled`;
- `force_cancel_audit` contains the source governance ActionRequest, target ActionRequest, actor, reason, timestamp, and `post_review_required=1`;
- the Workflow is terminated or otherwise no longer progressing;
- no external executor side effect occurred after cancellation.

The Cloudflare integration test `workflow.integration.test.ts` exercises this sequence against Workflows + D1.

## 5. Post review

Because force cancel is an escape hatch, create or attach a post-incident review. Record whether the root cause was application logic, dependency failure, bad deployment, policy/configuration, or operator error. Any corrective mutation must go through the normal governance path.
