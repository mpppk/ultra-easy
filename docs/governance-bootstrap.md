# Governance bootstrap path

The runtime API does not expose a privileged bypass for Action Definition, Approval Policy, or Approval Policy Binding changes.

## Bootstrap-only writes

Initial governance records may be installed only by one of these deployment-time mechanisms:

1. infrastructure-as-code executed by the deployment principal; or
2. a signed, version-controlled database migration whose digest is reviewed before deployment.

Bootstrap writes are intended only to establish the minimum Action Definitions and Approval Policies required for the platform to authorize its own governance actions. They are not an operator CRUD interface.

## Runtime rule

After bootstrap, governance changes MUST enter through the normal ActionRequest pipeline:

- `action_definition.publish`
- `approval_policy.publish`
- `approval_policy_binding.update`
- `admin.force_cancel`

These requests use the same trusted actor/authority context, authorization, approval-plan materialization, re-authorization, idempotency, execution, and append-only audit path as any other action.

There is intentionally no `admin.force_approve` action, endpoint, executor, or control port.

## Operational controls

Bootstrap migrations should record the source revision and content digest in the deployment record. Runtime services must not hold credentials that can invoke the bootstrap mechanism. A change that expands publish authority must therefore be authorized independently of the approval that governs the publish action itself.
