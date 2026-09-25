import { Result } from "@praha/byethrow";

import {
  knowledgeRepositories,
  type D1DatabaseLike,
  type KnowledgeRepositories,
} from "@app/knowledge-d1";

import { handleMcpRequest } from "../mcp/server.ts";
import { streamableHttpDownstream } from "../ultra-easy/mock/downstream.ts";
import { MockUltraEasy } from "../ultra-easy/mock/platform.ts";

export type KnowledgeEnv = {
  KNOWLEDGE_DB: D1DatabaseLike;
  ULTRA_EASY_MOCK_DB: D1DatabaseLike;
  /** "demo" (fixture principals, local/demo only) | "auth0" (not wired yet: fails closed). */
  KNOWLEDGE_AUTH_MODE?: string;
  /** "mock" until the ultra-easy Workflow Engine public API exists. */
  ULTRA_EASY_MODE?: string;
  KNOWLEDGE_ORGANIZATION_ID?: string;
  SESSION_SECRET?: string;
  KNOWLEDGE_MCP_TOKEN?: string;
};

export type KnowledgeRuntime = {
  repos: KnowledgeRepositories;
  ultraEasy: MockUltraEasy;
  now: () => string;
  organizationId: string;
  demo: boolean;
  sessionSecret: string;
  mcp: (request: Request) => Promise<Response>;
};

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

// Well-known local/demo secrets. Only ever used when KNOWLEDGE_AUTH_MODE=demo.
const DEMO_SESSION_SECRET = "knowledge-demo-session-secret-not-for-production";
const DEMO_MCP_TOKEN = "knowledge-demo-mcp-token-not-for-production";

export const MOCK_APPROVAL_BASE_PATH = "/mock/ultra-easy/approvals";

export function createRuntime(
  env: KnowledgeEnv,
  options: { now?: () => string } = {},
): Result.Result<KnowledgeRuntime, RuntimeConfigError> {
  const demo = (env.KNOWLEDGE_AUTH_MODE ?? "demo") === "demo";
  if (!demo) {
    // Auth0 sign-in is not wired into the example app yet: fail closed rather
    // than trusting anything the browser sends.
    return Result.fail(new RuntimeConfigError("KNOWLEDGE_AUTH_MODE=auth0 is not available yet"));
  }
  if ((env.ULTRA_EASY_MODE ?? "mock") !== "mock") {
    return Result.fail(new RuntimeConfigError("only ULTRA_EASY_MODE=mock is implemented"));
  }
  if (!env.KNOWLEDGE_DB || !env.ULTRA_EASY_MOCK_DB) {
    return Result.fail(
      new RuntimeConfigError("KNOWLEDGE_DB / ULTRA_EASY_MOCK_DB bindings are required"),
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  const repos = knowledgeRepositories(env.KNOWLEDGE_DB);
  const token = env.KNOWLEDGE_MCP_TOKEN || DEMO_MCP_TOKEN;
  const mcp = (request: Request) => handleMcpRequest(request, { repos, now, token });
  const ultraEasy = new MockUltraEasy({
    db: env.ULTRA_EASY_MOCK_DB,
    // The mock executor reaches Knowledge only through its MCP endpoint.
    downstream: streamableHttpDownstream({
      endpoint: "https://knowledge.internal/mcp",
      token,
      send: mcp,
    }),
    now,
    approvalBasePath: MOCK_APPROVAL_BASE_PATH,
  });
  return Result.succeed({
    repos,
    ultraEasy,
    now,
    organizationId: env.KNOWLEDGE_ORGANIZATION_ID || "org_acme",
    demo,
    sessionSecret: env.SESSION_SECRET || DEMO_SESSION_SECRET,
    mcp,
  });
}
