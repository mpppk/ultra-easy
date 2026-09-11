import type { ActionDefinitionKey, ActionType, ExecutorKey } from "./domain/brand.ts";
import type { PolicyFieldDefinition } from "./domain/evaluation.ts";
import type { SchemaReference } from "./schema.ts";

/**
 * publish済みAction Definition Versionはimmutableとして扱う。
 * executorKey / inputSchema / normalizationVersion等の実行意味を変更する場合は、
 * 既存versionを書き換えず必ず新しいversionをpublishする。
 * actionFingerprintはこのversion不変条件を前提としてAction Definitionを識別する。
 */
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
