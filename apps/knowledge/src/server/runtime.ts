import { Result } from "@praha/byethrow";

import {
  knowledgeRepositories,
  type D1DatabaseLike,
  type KnowledgeRepositories,
} from "@app/knowledge-d1";

import { handleMcpRequest } from "../mcp/server.ts";
import { Auth0Client, readAuth0Config, type Auth0Dependencies } from "./auth0.ts";
import { streamableHttpDownstream } from "../ultra-easy/mock/downstream.ts";
import { MockUltraEasy } from "../ultra-easy/mock/platform.ts";

export type KnowledgeEnv = {
  KNOWLEDGE_DB: D1DatabaseLike;
  ULTRA_EASY_MOCK_DB: D1DatabaseLike;
  /**
   * "auth0" (trusted Auth0 session, the deployed default) | "demo" (fixture
   * principals; enabled only by the local dev server, see vite.config.ts).
   * Unset or unknown fails closed.
   */
  KNOWLEDGE_AUTH_MODE?: string;
  /** "mock" until the ultra-easy Workflow Engine public API exists. */
  ULTRA_EASY_MODE?: string;
  KNOWLEDGE_ORGANIZATION_ID?: string;
  SESSION_SECRET?: string;
  KNOWLEDGE_MCP_TOKEN?: string;
  AUTH0_DOMAIN?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  AUTH0_ORGANIZATION_CLAIM?: string;
  AUTH0_ORGANIZATION_CLAIM_VALUE?: string;
  AUTH0_TENANT_IS_ORGANIZATION?: string;
};

export type KnowledgeAuth = { mode: "demo" } | { mode: "auth0"; auth0: Auth0Client };

export type KnowledgeRuntime = {
  repos: KnowledgeRepositories;
  ultraEasy: MockUltraEasy;
  now: () => string;
  organizationId: string;
  demo: boolean;
  auth: KnowledgeAuth;
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
  options: { now?: () => string; auth0?: Auth0Dependencies } = {},
): Result.Result<KnowledgeRuntime, RuntimeConfigError> {
  const mode = env.KNOWLEDGE_AUTH_MODE?.trim();
  if (mode !== "demo" && mode !== "auth0") {
    return Result.fail(new RuntimeConfigError('KNOWLEDGE_AUTH_MODE must be "auth0" or "demo"'));
  }
  const demo = mode === "demo";
  let auth: KnowledgeAuth = { mode: "demo" };
  if (!demo) {
    // Outside demo mode nothing falls back to the well-known local values.
    if ((env.SESSION_SECRET?.length ?? 0) < 32) {
      return Result.fail(new RuntimeConfigError("SESSION_SECRET (32+ chars) is required"));
    }
    if (!env.KNOWLEDGE_MCP_TOKEN) {
      return Result.fail(new RuntimeConfigError("KNOWLEDGE_MCP_TOKEN is required"));
    }
    const config = readAuth0Config(env);
    if (Result.isFailure(config)) {
      return Result.fail(new RuntimeConfigError(config.error.message));
    }
    auth = { mode: "auth0", auth0: new Auth0Client(config.value, options.auth0) };
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
    auth,
    sessionSecret: env.SESSION_SECRET || DEMO_SESSION_SECRET,
    mcp,
  });
}
