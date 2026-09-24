import {
  authorizationAdminActionRelation,
  type ActionType,
  type RelationName,
  type ResourceRef,
} from "@app/approval-core";

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
  if (String(action.type) === "ticket.update") return "can_execute" as RelationName;
  return authorizationAdminActionRelation({ actionType: action.type, resource: action.resource });
}
