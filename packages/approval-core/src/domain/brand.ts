import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

declare const brand: unique symbol;

/**
 * 実行時表現を変えず、TypeScript上だけで値の意味を区別するためのブランド型。
 *
 * 外部入力を直接castするためのものではない。API / DB / JSON等の境界では
 * validation後に対応するブランド型へ変換する。
 */
export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type UserId = Brand<string, "UserId">;
export type AgentId = Brand<string, "AgentId">;
export type ServiceId = Brand<string, "ServiceId">;
export type PrincipalId = UserId | AgentId | ServiceId;

export type ActionRequestId = Brand<string, "ActionRequestId">;
export type ActionType = Brand<string, "ActionType">;
export type ActionDefinitionKey = Brand<string, "ActionDefinitionKey">;
export type ExecutorKey = Brand<string, "ExecutorKey">;
export type ResourceType = Brand<string, "ResourceType">;
export type ResourceId = Brand<string, "ResourceId">;

export type OrganizationId = Brand<string, "OrganizationId">;
export type DelegationGrantId = Brand<string, "DelegationGrantId">;
export type ClientId = Brand<string, "ClientId">;
export type AgentRunId = Brand<string, "AgentRunId">;

export type ApprovalPolicyKey = Brand<string, "ApprovalPolicyKey">;
export type ApprovalPolicyBindingId = Brand<string, "ApprovalPolicyBindingId">;
export type ApprovalRuleKey = Brand<string, "ApprovalRuleKey">;
export type ApprovalStepKey = Brand<string, "ApprovalStepKey">;
export type ApprovalTaskId = Brand<string, "ApprovalTaskId">;
export type MaterializedStepId = Brand<string, "MaterializedStepId">;
export type SnapshotApproverCohortId = Brand<string, "SnapshotApproverCohortId">;

export type Sha256Digest = Brand<string, "Sha256Digest">;
export type ActionFingerprint = Brand<string, "ActionFingerprint">;
export type EvaluationSnapshotChecksum = Brand<string, "EvaluationSnapshotChecksum">;
export type ApprovalPlanChecksum = Brand<string, "ApprovalPlanChecksum">;
export type ApprovalBindingFingerprint = Brand<string, "ApprovalBindingFingerprint">;

export type SchemaKey = Brand<string, "SchemaKey">;

export type RelationName = Brand<string, "RelationName">;
export type AuthorizationObjectType = Brand<string, "AuthorizationObjectType">;
export type AuthorizationObjectRef = Brand<string, "AuthorizationObjectRef">;

/**
 * brand名の一覧。brandへの変換はこのファイルの関数だけが行い、それ以外での`as <Brand>`は
 * lintで禁止する（#102）。
 */
export type BrandKind =
  | "UserId"
  | "AgentId"
  | "ServiceId"
  | "ActionRequestId"
  | "ActionType"
  | "ActionDefinitionKey"
  | "ExecutorKey"
  | "ResourceType"
  | "ResourceId"
  | "OrganizationId"
  | "DelegationGrantId"
  | "ClientId"
  | "AgentRunId"
  | "ApprovalPolicyKey"
  | "ApprovalPolicyBindingId"
  | "ApprovalRuleKey"
  | "ApprovalStepKey"
  | "ApprovalTaskId"
  | "MaterializedStepId"
  | "SnapshotApproverCohortId"
  | "Sha256Digest"
  | "ActionFingerprint"
  | "EvaluationSnapshotChecksum"
  | "ApprovalPlanChecksum"
  | "ApprovalBindingFingerprint"
  | "SchemaKey"
  | "RelationName"
  | "AuthorizationObjectType"
  | "AuthorizationObjectRef";

export class InvalidBrandValueError extends ErrorFactory({
  name: "InvalidBrandValueError",
  message: ({ kind }) => `${kind}として不正な値です`,
  fields: ErrorFactory.fields<{ code: "invalid_brand_value"; kind: BrandKind }>(),
}) {}

/** 識別子として受け付ける長さの上限。 */
export const MAX_BRAND_VALUE_LENGTH = 1024;

// 制御文字（C0 / DEL）を含まない1文字以上の文字列だけを識別子として受け付ける。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isValidBrandValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BRAND_VALUE_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/**
 * 外部境界（HTTP path / body、D1 row、JSON、env、queue message）の値を検証してbrandへ変換する
 * smart constructor。空文字・長すぎる値・制御文字を含む値を拒否する。
 */
export function parseBrand<K extends BrandKind>(
  kind: K,
  value: unknown,
): Result.Result<Brand<string, K>, InvalidBrandValueError> {
  return isValidBrandValue(value)
    ? Result.succeed(value as Brand<string, K>)
    : Result.fail(new InvalidBrandValueError({ code: "invalid_brand_value", kind }));
}

/** 配列の各要素を`parseBrand`で変換する（1つでも不正ならerror）。 */
export function parseBrands<K extends BrandKind>(
  kind: K,
  values: readonly unknown[],
): Result.Result<Brand<string, K>[], InvalidBrandValueError> {
  const parsed: Brand<string, K>[] = [];
  for (const value of values) {
    const item = parseBrand(kind, value);
    if (Result.isFailure(item)) return item;
    parsed.push(item.value);
  }
  return Result.succeed(parsed);
}

/**
 * コード中のstring literal定数をbrandにする（外部入力には使えない: literal型だけを受け付け、
 * `string`型の値はcompile errorになる）。
 */
export function brandLiteral<K extends BrandKind, const V extends string>(
  kind: K,
  value: string extends V ? never : V,
): Brand<V, K> {
  void kind;
  return value as V as Brand<V, K>;
}

/** 生成したUUIDから新しい識別子を作る（例: `action:<uuid>`）。 */
export function newIdentifier<K extends BrandKind>(kind: K, prefix: string): Brand<string, K> {
  void kind;
  return `${prefix}:${globalThis.crypto.randomUUID()}` as Brand<string, K>;
}

/** SHA-256のhex digestから`sha256:<hex>`を作る。 */
export function sha256Digest(hex: string): Sha256Digest {
  return `sha256:${hex}` as Sha256Digest;
}

/** canonical JSONのdigestを、その用途のbrand（fingerprint / checksum）として扱う。 */
export function digestAs<
  K extends
    | "ActionFingerprint"
    | "EvaluationSnapshotChecksum"
    | "ApprovalPlanChecksum"
    | "ApprovalBindingFingerprint",
>(kind: K, digest: Sha256Digest): Brand<string, K> {
  void kind;
  return String(digest) as Brand<string, K>;
}

/** digestから`<prefix>:<hex>`形式の導出IDを作る（MaterializedStepId等）。 */
export function derivedIdentifier<K extends "MaterializedStepId" | "SnapshotApproverCohortId">(
  kind: K,
  prefix: string,
  digest: Sha256Digest,
): Brand<string, K> {
  void kind;
  return `${prefix}:${String(digest).slice("sha256:".length)}` as Brand<string, K>;
}

/** ActionRequestとMaterialized StepからApproval Task IDを導出する。 */
export function approvalTaskIdOf(
  actionRequestId: ActionRequestId,
  materializedStepId: MaterializedStepId,
): ApprovalTaskId {
  return `task:${String(actionRequestId)}:${String(materializedStepId)}` as ApprovalTaskId;
}

/** object typeを前置した`<type>:<id>`形式の参照を作る（既に前置済みならそのまま）。 */
export function authorizationObjectRefOf(type: string, id: string): AuthorizationObjectRef {
  const prefix = `${type}:`;
  return (id.startsWith(prefix) ? id : `${prefix}${id}`) as AuthorizationObjectRef;
}
