import { fileURLToPath } from "node:url";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";
import { unstable_readConfig } from "wrangler";

import { REQUIRED_BINDINGS, REQUIRED_SETTINGS, validateApprovalApiConfig } from "./config.ts";

const binding = {};
const validEnv = {
  DB: binding,
  ACTION_AUTHORIZER: binding,
  ACTION_EXECUTOR: binding,
  ACTION_WORKFLOW: binding,
  NOTIFICATION_QUEUE: binding,
  AUTH0_DOMAIN: "tenant.example.auth0.com",
  AUTH0_API_AUDIENCE: "https://ultra-easy/approval-api",
  AUTH0_ORGANIZATION_ID: "organization:staging",
  AUTH0_TENANT_IS_ORGANIZATION: "true",
  OPENFGA_API_URL: "https://api.us1.fga.dev",
  OPENFGA_STORE_ID: "store",
  OPENFGA_AUTHORIZATION_MODEL_ID: "model",
  FGA_CLIENT_ID: "client",
  FGA_CLIENT_SECRET: "super-secret-value",
};

describe("#84 validateApprovalApiConfig", () => {
  it("必須binding・設定が揃っていれば通す", () => {
    expect(Result.isSuccess(validateApprovalApiConfig(validEnv))).toBe(true);
  });

  it("欠落した設定を名前だけで列挙する（値は含めない）", () => {
    const { DB: _db, ACTION_AUTHORIZER: _authorizer, AUTH0_DOMAIN: _domain, ...rest } = validEnv;
    const result = validateApprovalApiConfig({ ...rest, FGA_CLIENT_ID: "  " });
    assert(Result.isFailure(result));
    expect(result.error.code).toBe("configuration_invalid");
    expect(result.error.keys).toEqual(["DB", "ACTION_AUTHORIZER", "AUTH0_DOMAIN", "FGA_CLIENT_ID"]);
    expect(result.error.message).not.toContain("super-secret-value");
  });

  it("不正な値と、組織所属の検証方法が無い設定を拒否する", () => {
    const { AUTH0_TENANT_IS_ORGANIZATION: _tenant, ...rest } = validEnv;
    const result = validateApprovalApiConfig({
      ...rest,
      AUTH0_ORGANIZATION_ID: "organization:\u0000control",
      OPENFGA_API_URL: "not a url",
      ACTION_EXECUTION_MODE: "yolo",
    });
    assert(Result.isFailure(result));
    expect(result.error.keys).toEqual([
      "AUTH0_ORGANIZATION_ID",
      "OPENFGA_API_URL",
      "ACTION_EXECUTION_MODE",
      "AUTH0_ORGANIZATION_CLAIM_VALUE|AUTH0_TENANT_IS_ORGANIZATION",
    ]);
  });
});

describe("#84 wrangler environments", () => {
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  /** productionのprovision時に追加する設定（wrangler.jsonc env.productionのコメントと一致させる）。 */
  const PROVISIONED_AT_CUTOVER = [
    "AUTH0_DOMAIN",
    "AUTH0_API_AUDIENCE",
    "OPENFGA_STORE_ID",
    "OPENFGA_AUTHORIZATION_MODEL_ID",
    "FGA_CLIENT_ID",
    "FGA_CLIENT_SECRET",
  ];
  const SECRETS = ["FGA_CLIENT_ID", "FGA_CLIENT_SECRET"];

  for (const [environment, workerName] of [
    [undefined, "ultra-easy-approval-api"],
    ["production", "ultra-easy-approval-api-production"],
  ] as const) {
    it(`${environment ?? "staging"}: 必須bindingを全て宣言し、自workerのentrypointを指す`, () => {
      const config = unstable_readConfig({
        config: configPath,
        ...(environment ? { env: environment } : {}),
      });
      const bindings = (entries: readonly { binding: string }[] | undefined) =>
        (entries ?? []).map((entry) => entry.binding);
      const declared = new Set([
        ...bindings(config.d1_databases),
        ...bindings(config.services),
        ...bindings(config.workflows),
        ...bindings(config.queues.producers),
      ]);
      for (const name of REQUIRED_BINDINGS) expect(declared, name).toContain(name);
      for (const service of (config.services ?? []) as { service: string }[]) {
        expect(service.service).toBe(workerName);
      }

      const vars = Object.keys(config.vars);
      const missing = REQUIRED_SETTINGS.filter((name) => !vars.includes(name));
      expect(missing).toEqual(environment === "production" ? PROVISIONED_AT_CUTOVER : SECRETS);
    });
  }
});
