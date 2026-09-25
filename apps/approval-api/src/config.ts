import { Result } from "@praha/byethrow";
import { parseBrand } from "@app/approval-core";

import { readAuth0OrganizationMembership } from "./auth0-identity.ts";

/** 必須のbinding（#84）。non-inheritableなのでwrangler環境ごとに宣言が要る。 */
export const REQUIRED_BINDINGS = [
  "DB",
  "ACTION_AUTHORIZER",
  "ACTION_EXECUTOR",
  "ACTION_WORKFLOW",
  "NOTIFICATION_QUEUE",
] as const;

/** 必須のvar / secret（値はlogへ出さず、名前だけを報告する）。 */
export const REQUIRED_SETTINGS = [
  "AUTH0_DOMAIN",
  "AUTH0_API_AUDIENCE",
  "AUTH0_ORGANIZATION_ID",
  "OPENFGA_API_URL",
  "OPENFGA_STORE_ID",
  "OPENFGA_AUTHORIZATION_MODEL_ID",
  "FGA_CLIENT_ID",
  "FGA_CLIENT_SECRET",
] as const;

export class ApprovalApiConfigError extends Error {
  readonly name = "ApprovalApiConfigError";
  readonly code = "configuration_invalid";

  constructor(
    /** 欠落・不正な設定の名前（値は含めない）。 */
    readonly keys: readonly string[],
  ) {
    super(`approval-apiの必須設定が欠落・不正です: ${keys.join(", ")}`);
  }
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/**
 * 起動時の設定検証（#84）。必須binding・varsの欠落や不正値を名前付きで返す。
 * `wrangler deploy --env <env>`で環境ごとの宣言が漏れても、全リクエストが原因不明の500に
 * なる代わりに、どの設定が無いかを明示する。
 */
export function validateApprovalApiConfig(
  env: Record<string, unknown>,
): Result.Result<void, ApprovalApiConfigError> {
  const keys: string[] = [];
  for (const binding of REQUIRED_BINDINGS) if (!present(env[binding])) keys.push(binding);
  for (const setting of REQUIRED_SETTINGS) if (!present(env[setting])) keys.push(setting);

  if (
    present(env.AUTH0_ORGANIZATION_ID) &&
    Result.isFailure(parseBrand("OrganizationId", env.AUTH0_ORGANIZATION_ID))
  ) {
    keys.push("AUTH0_ORGANIZATION_ID");
  }
  if (present(env.OPENFGA_API_URL) && !URL.canParse(String(env.OPENFGA_API_URL))) {
    keys.push("OPENFGA_API_URL");
  }
  const mode = env.ACTION_EXECUTION_MODE;
  if (mode !== undefined && mode !== "execute" && mode !== "approval_only") {
    keys.push("ACTION_EXECUTION_MODE");
  }
  // 組織所属の検証方法が無いと全リクエストが403になる。設定漏れとして明示する。
  const membership = readAuth0OrganizationMembership({
    ...(typeof env.AUTH0_ORGANIZATION_CLAIM === "string"
      ? { AUTH0_ORGANIZATION_CLAIM: env.AUTH0_ORGANIZATION_CLAIM }
      : {}),
    ...(typeof env.AUTH0_ORGANIZATION_CLAIM_VALUE === "string"
      ? { AUTH0_ORGANIZATION_CLAIM_VALUE: env.AUTH0_ORGANIZATION_CLAIM_VALUE }
      : {}),
    ...(typeof env.AUTH0_TENANT_IS_ORGANIZATION === "string"
      ? { AUTH0_TENANT_IS_ORGANIZATION: env.AUTH0_TENANT_IS_ORGANIZATION }
      : {}),
  });
  if (!membership) keys.push("AUTH0_ORGANIZATION_CLAIM_VALUE|AUTH0_TENANT_IS_ORGANIZATION");

  const unique = [...new Set(keys)];
  return unique.length === 0
    ? Result.succeed(undefined)
    : Result.fail(new ApprovalApiConfigError(unique));
}

const validated = new WeakMap<object, Result.Result<void, ApprovalApiConfigError>>();

/** isolate内ではenvごとに1回だけ検証する。 */
export function approvalApiConfig(env: object): Result.Result<void, ApprovalApiConfigError> {
  const cached = validated.get(env);
  if (cached) return cached;
  const result = validateApprovalApiConfig(env as Record<string, unknown>);
  validated.set(env, result);
  return result;
}
