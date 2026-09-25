import type { Result } from "@praha/byethrow";

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

export class ActionDefinitionResolverError extends Error {
  readonly name = "ActionDefinitionResolverError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** Action typeからpublish済みAction Definitionを解決するPort。 */
export interface ActionDefinitionResolver {
  /**
   * 未publishのaction typeはnull（利用者の入力誤り）。依存障害・保存データ破損だけをerrorで返す。
   */
  resolve(
    actionType: ActionType,
  ): Result.ResultAsync<ActionDefinition | null, ActionDefinitionResolverError>;
}
