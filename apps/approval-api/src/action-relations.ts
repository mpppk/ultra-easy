import {
  authorizationAdminActionRelation,
  APPLICATION_RELATIONSHIP_ACTION_TYPE,
  type ActionType,
  type RelationName,
  type ResourceRef,
} from "@app/approval-core";
import { brandLiteral, parseBrand } from "@app/approval-core";
import { Result } from "@praha/byethrow";

import { APPLICATION_CATALOGS } from "./catalog/knowledge.ts";
import { catalogActionRelation } from "./catalog/manifest.ts";

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
  if (
    String(action.type) === String(APPLICATION_RELATIONSHIP_ACTION_TYPE) &&
    String(action.resource.type) === "knowledge_space"
  ) {
    return brandLiteral("RelationName", "can_manage");
  }
  // Application Catalog（#198）: 登録済みaction type × resource typeに宣言されたrelation。
  const declared = catalogActionRelation(APPLICATION_CATALOGS, {
    type: String(action.type),
    resourceType: String(action.resource.type),
  });
  if (declared) {
    const relation = parseBrand("RelationName", declared);
    return Result.isSuccess(relation) ? relation.value : null;
  }
  return authorizationAdminActionRelation({ actionType: action.type, resource: action.resource });
}
