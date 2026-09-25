import {
  authorizationAdminActionRelation,
  type ActionType,
  type RelationName,
  type ResourceRef,
} from "@app/approval-core";
import { brandLiteral } from "@app/approval-core";

/**
 * Action → FGA relation map for this deployment. Shared by the
 * ActionAuthorizer entrypoint and the admin Explorer describer so both
 * always agree on which relation/object is checked. Unmapped actions return
 * null and are denied without a provider call (fail closed).
 */
export function stagingActionRelation(action: {
  type: ActionType;
  resource: ResourceRef;
}): RelationName | null {
  // ticket.escalate is a staging fixture for parallel (any/all/quorum) approval flows.
  if (String(action.type) === "ticket.update" || String(action.type) === "ticket.escalate") {
    return brandLiteral("RelationName", "can_execute");
  }
  return authorizationAdminActionRelation({ actionType: action.type, resource: action.resource });
}
