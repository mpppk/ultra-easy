import type { OrganizationId } from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import { D1ActionResultProjectionRepository } from "./action-result-projection-repository.ts";
import { D1AsyncActionExecutionRepository } from "./async-action-execution-repository.ts";
import {
  D1PublishedActionDefinitionResolver,
  D1PublishedPolicyBindingResolver,
} from "./governance-repository.ts";
import {
  D1MaterializedPlanRepository,
  type D1DatabaseLike,
} from "./materialized-plan-repository.ts";

/**
 * ActionRequestApplicationServiceのD1永続化依存を1か所で組み立てる（#85 / #105）。
 * appsはこれをspreadして使い、監査・結果repositoryの配線漏れを起こさない。
 */
export function createD1ActionRequestPersistence(
  db: D1DatabaseLike,
  organizationId: OrganizationId,
) {
  return {
    actionDefinitionResolver: new D1PublishedActionDefinitionResolver(db, organizationId),
    policyBindingResolver: new D1PublishedPolicyBindingResolver(db),
    planRepository: new D1MaterializedPlanRepository(db),
    eventRepository: new D1ActionEventRepository(db),
    resultRepository: new D1ActionResultProjectionRepository(db),
    asyncExecutions: new D1AsyncActionExecutionRepository(db),
  };
}
