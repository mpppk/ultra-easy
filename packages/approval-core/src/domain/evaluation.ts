import type { ActionRequest } from "./action.ts";
import type { OrganizationId } from "./brand.ts";
import type { FlowConstraints } from "./flow.ts";
import type { JsonValue } from "./json.ts";

export type PolicyEvaluationOrganization = {
  id: OrganizationId;
  settings?: Record<string, JsonValue>;
  defaultFlowConstraints?: FlowConstraints;
};

/** Policy評価へ渡す、外部I/O解決済みの固定コンテキスト。 */
export type PolicyEvaluationContext = ActionRequest & {
  organization: PolicyEvaluationOrganization;
  attributes?: Record<string, JsonValue>;
  now: string;
};

export type PolicyFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date_time"
  | "money_minor"
  | "string_array"
  | "number_array"
  | "boolean_array";

export type PolicyFieldDefinition = {
  path: string;
  type: PolicyFieldType;
  label?: string;
  /** type=money_minorのとき、同じ金額の通貨コードを保持するfield path。 */
  currencyPath?: string;
};

export type PolicyFieldCatalog = readonly PolicyFieldDefinition[];
