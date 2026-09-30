import { brandLiteral } from "./domain/brand.ts";

import type { ActionDefinition } from "./action-definition.ts";
import type { Action } from "./domain/action.ts";
import {
  relationshipUpdateInputSchema,
  validateRelationshipUpdateInput,
  type AuthorizationRelationshipUpdateInput,
  type ManagedRelationshipCatalog,
} from "./authorization-admin.ts";

export const APPLICATION_RELATIONSHIP_ACTION_TYPE = brandLiteral(
  "ActionType",
  "application.relationship.update",
);

export const APPLICATION_RELATIONSHIP_UPDATE_DEFINITION: ActionDefinition = {
  key: brandLiteral("ActionDefinitionKey", "application:relationship-update"),
  version: 1,
  actionType: APPLICATION_RELATIONSHIP_ACTION_TYPE,
  inputSchema: { key: brandLiteral("SchemaKey", "application:relationship-update"), version: 1 },
  executorKey: brandLiteral("ExecutorKey", "authorization"),
};

/** Reviewed, application-owned relation pairs. Console-only relations stay separate. */
export const APPLICATION_RELATIONSHIP_CATALOG: ManagedRelationshipCatalog = [
  {
    objectType: "knowledge_space",
    relation: "owner",
    subjectTypes: ["user"],
    description: "Knowledge space owner",
  },
  {
    objectType: "knowledge_space",
    relation: "editor",
    subjectTypes: ["user"],
    description: "Knowledge space editor",
  },
  {
    objectType: "knowledge_space",
    relation: "viewer",
    subjectTypes: ["user"],
    description: "Knowledge space viewer",
  },
];

export const applicationRelationshipUpdateInputSchema = () =>
  relationshipUpdateInputSchema(APPLICATION_RELATIONSHIP_CATALOG);

/** Rechecked by the executor after the normal ActionRequest schema validation. */
export function validateApplicationRelationshipAction(
  action: Action,
):
  | { type: "valid"; input: AuthorizationRelationshipUpdateInput }
  | { type: "invalid"; code: string } {
  if (
    String(action.type) !== String(APPLICATION_RELATIONSHIP_ACTION_TYPE) ||
    String(action.resource.type) !== "knowledge_space"
  )
    return { type: "invalid", code: "invalid_application_relationship_action" };
  const validated = validateRelationshipUpdateInput(action.input, APPLICATION_RELATIONSHIP_CATALOG);
  if (validated.type === "invalid")
    return { type: "invalid", code: "invalid_application_relationship_update" };
  if (validated.input.tuple.object !== `knowledge_space:${String(action.resource.id)}`)
    return { type: "invalid", code: "relationship_resource_mismatch" };
  return { type: "valid", input: validated.input };
}
