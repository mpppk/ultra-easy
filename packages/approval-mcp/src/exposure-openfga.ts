import { Result } from "@praha/byethrow";

import type { AuthorizationConsistency } from "@app/approval-core";

import {
  McpExposureProviderError,
  type McpToolExposureAuthorizer,
  type McpToolExposureDecision,
  type McpToolExposureRequest,
} from "./exposure.ts";

export const MCP_TOOL_OPENFGA_TYPE = "mcp_tool" as const;
export const MCP_TOOL_OPENFGA_RELATION = "can_use" as const;

/**
 * `@app/approval-fga` の `OpenFgaClient` が構造的に満たすcheck Port。
 * OpenFgaClientはorganization単位で構築され、objectを `mcp_tool:<org>/<actionType>` へtenant-scopeする。
 */
export interface McpToolRelationshipChecker {
  check(input: {
    user: string;
    relation: string;
    object: string;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, { code: string; retriable: boolean; message: string }>;
}

/**
 * OpenFGA model `mcp_tool#can_use` によるTool Exposure。
 * authority principal（委任時は委任元user）がActionTypeのtoolを使えるかだけを判定し、
 * resource単位の実行可否はtools/call時のFull Action Authorizationに委ねる。
 */
export class OpenFgaMcpToolExposureAuthorizer implements McpToolExposureAuthorizer {
  constructor(
    private readonly checker: McpToolRelationshipChecker,
    private readonly options: { consistency?: AuthorizationConsistency } = {},
  ) {}

  async check(
    input: McpToolExposureRequest,
  ): Result.ResultAsync<McpToolExposureDecision, McpExposureProviderError> {
    const principal = input.authority.principal;
    if (principal.type !== "user") {
      return Result.succeed({ type: "deny", code: "exposure_principal_type_unsupported" });
    }
    const id = String(principal.id);
    const checked = await this.checker.check({
      user: id.startsWith("user:") ? id : `user:${id}`,
      relation: MCP_TOOL_OPENFGA_RELATION,
      object: `${MCP_TOOL_OPENFGA_TYPE}:${String(input.actionType)}`,
      consistency: this.options.consistency ?? "minimize_latency",
    });
    if (Result.isFailure(checked)) {
      return Result.fail(
        new McpExposureProviderError(
          checked.error.code,
          checked.error.retriable,
          checked.error.message,
        ),
      );
    }
    return Result.succeed(
      checked.value ? { type: "allow" } : { type: "deny", code: "fga_mcp_tool_not_usable" },
    );
  }
}
