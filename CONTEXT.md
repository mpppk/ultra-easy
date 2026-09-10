# Approval Workflow Platform

A platform for representing an intended application operation as an Action Request, authorizing it, determining whether human approval is required, and eventually executing it. This context defines the business language shared by human-, service-, and AI-initiated operations.

## Language

**Action Request**:
A request to perform one Action, recording who directly initiated it, whose authority it relies on, and where it originated.
_Avoid_: Approval Request, Workflow Request

**Principal**:
An identity that can participate in the domain as a user, agent, or service.
_Avoid_: Actor when referring to an identity in general

**Actor**:
The Principal that directly initiated the Action Request at the platform boundary. The Actor is not necessarily the Principal whose authority is used.
_Avoid_: Requester when authority is intended

**Authority Principal**:
The Principal whose permissions are the basis for an Action Request. Approval never grants the Authority Principal permissions they do not already have.
_Avoid_: Actor, Requester

**Delegation**:
An explicit, attenuating grant that allows another Principal to act using part of an Authority Principal's authority. A delegation chain must never become more permissive as it is extended.
_Avoid_: Impersonation

**Action**:
A typed operation, its target Resource, and the input required to perform it.
_Avoid_: Approval, Workflow

**Resource**:
The domain object targeted by an Action, identified by a resource type and resource ID.
_Avoid_: Object when referring to the target of an Action

**Origin**:
The trusted channel or execution context from which an Action Request entered the platform, such as UI, API, MCP, or system automation.
_Avoid_: Actor, Caller

**Caller**:
The immediate trusted Principal that caused an agent- or service-mediated Action Request to be created when that identity is relevant. The Caller is context, not automatically the Authority Principal.
_Avoid_: Creator, Owner

**Authorization**:
The decision about whether an Action Request may proceed under its current Authority Principal and delegation. Authorization is evaluated independently from Approval.
_Avoid_: Approval

**Approval**:
A required human decision that permits an already-authorized Action Request to continue. Approval does not elevate or create authority.
_Avoid_: Authorization, Permission

**Approval Policy**:
A versioned rule set that maps an authorized Action Request and evaluation context to an Approval Flow.
_Avoid_: Workflow Definition

**Policy Binding**:
The rule that determines where an Approval Policy applies, including the relevant action/resource selectors and composition order.
_Avoid_: Policy Scope

**Rule**:
A Condition and resulting Flow within an Approval Policy. Rules are ordered and a policy selects the first matching Rule.
_Avoid_: Policy

**Condition**:
A serializable predicate over approved field namespaces used to decide whether a Rule or Policy Binding applies.
_Avoid_: Callback, Script

**Flow**:
The serializable structure of required Approval Steps and their serial or parallel composition.
_Avoid_: Workflow when referring to the policy-defined approval structure

**No Approval**:
An explicit Flow result meaning that a Policy requires no additional human approval. It is distinct from no applicable Policy, an evaluation error, or an authorization denial.
_Avoid_: Missing Flow

**Approval Step**:
A single approval requirement within a Flow, including who may approve and constraints such as candidate completion and self-approval.
_Avoid_: Task when referring to the policy definition

**Approver Expression**:
A serializable description of who is eligible to approve an Approval Step, expressed as a Principal, relationship, or explicit user reference rather than a pre-resolved concrete candidate list.
_Avoid_: Approver List

**Decision**:
An immutable approval outcome submitted for an Approval Step, such as approve or reject.
_Avoid_: Permission
