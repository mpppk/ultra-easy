import type { ActionDefinitionKey, ActionType, ExecutorKey } from "./domain/brand.ts";
import type { PolicyFieldDefinition } from "./domain/evaluation.ts";
import type { SchemaReference } from "./schema.ts";

export type ActionDefinition = {
  key: ActionDefinitionKey;
  version: number;
  actionType: ActionType;
  inputSchema: SchemaReference;
  executorKey: ExecutorKey;
  normalizationVersion?: number;
  derivedAttributeCatalog?: PolicyFieldDefinition[];
};

/** Action typeからpublish済みAction Definitionを解決するPort。 */
export interface ActionDefinitionResolver {
  resolve(actionType: ActionType): ActionDefinition | Promise<ActionDefinition>;
}
