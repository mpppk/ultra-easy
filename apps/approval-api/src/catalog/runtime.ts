import { Result } from "@praha/byethrow";

import type { ActionExecutor, TelemetrySink } from "@app/approval-core";
import { D1McpActionRouteRepository, type D1DatabaseLike } from "@app/approval-d1";
import {
  McpCatalogActionExecutor,
  McpGatewayError,
  StreamableHttpMcpDownstreamClient,
  mcpCatalogExecutorKey,
  type FetchLike,
  type McpDownstreamCredentialProvider,
  type McpDownstreamServer,
  type McpDownstreamServerRegistry,
} from "@app/approval-mcp";

import { APPLICATION_CATALOGS } from "./knowledge.ts";
import type { ApplicationCatalog, CatalogMcpServer } from "./manifest.ts";

type ServiceFetcher = { fetch(input: Request): Promise<Response> };

/** Catalogのserverに使うdeployment設定（binding / var / secret名はcatalogが宣言する）。 */
export type CatalogRuntimeEnv = { DB: D1DatabaseLike };

function setting(env: CatalogRuntimeEnv, name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name];
}

function isFetcher(value: unknown): value is ServiceFetcher {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { fetch?: unknown }).fetch === "function"
  );
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Service Bindingは固定hostのURLで呼ぶ（hostはbinding先Workerへのroutingに使われない）。 */
const SERVICE_BINDING_ORIGIN = "https://service-binding.internal";

function downstreamServer(
  env: CatalogRuntimeEnv,
  server: CatalogMcpServer,
): McpDownstreamServer | null {
  const credentialRef = server.tokenSecret;
  const timeout = server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {};
  if (isFetcher(setting(env, server.serviceBinding))) {
    return {
      id: server.id,
      endpoint: `${SERVICE_BINDING_ORIGIN}${server.path}`,
      credentialRef,
      ...timeout,
    };
  }
  const endpoint = nonEmpty(setting(env, server.endpointVar));
  return endpoint ? { id: server.id, endpoint, credentialRef, ...timeout } : null;
}

/** Catalogのserverをdeployment設定から解決する。未設定のserverはnull（executorはfail-closed）。 */
class CatalogServerRegistry implements McpDownstreamServerRegistry {
  constructor(
    private readonly env: CatalogRuntimeEnv,
    private readonly server: CatalogMcpServer,
  ) {}

  resolve(serverId: string) {
    return Promise.resolve(
      Result.succeed(serverId === this.server.id ? downstreamServer(this.env, this.server) : null),
    );
  }
}

/** Bearer tokenはWorker secretから都度読み、binding / route / logへ保存しない。 */
class SecretBearerCredentials implements McpDownstreamCredentialProvider {
  constructor(private readonly env: CatalogRuntimeEnv) {}

  headers(input: { server: McpDownstreamServer }) {
    const token = input.server.credentialRef
      ? nonEmpty(setting(this.env, input.server.credentialRef))
      : null;
    return Promise.resolve(
      token
        ? Result.succeed({ authorization: `Bearer ${token}` })
        : Result.fail(
            new McpGatewayError(
              "mcp_downstream_credentials_missing",
              true,
              `downstream credentialが設定されていません: ${input.server.id}`,
            ),
          ),
    );
  }
}

function serverFetch(env: CatalogRuntimeEnv, server: CatalogMcpServer): FetchLike {
  return (url, init) => {
    const binding = setting(env, server.serviceBinding);
    return isFetcher(binding) ? binding.fetch(new Request(url, init)) : fetch(url, init);
  };
}

/** Catalogが宣言するMCP serverごとのprimitive executor（executorKey = `mcp:<serverId>`）。 */
export function catalogActionExecutors(
  env: CatalogRuntimeEnv,
  options: { telemetry?: TelemetrySink; catalogs?: readonly ApplicationCatalog[] } = {},
): Record<string, ActionExecutor> {
  const executors: Record<string, ActionExecutor> = {};
  for (const server of (options.catalogs ?? APPLICATION_CATALOGS).flatMap(
    (catalog) => catalog.servers,
  )) {
    executors[mcpCatalogExecutorKey(server.id)] = new McpCatalogActionExecutor({
      serverId: server.id,
      routes: new D1McpActionRouteRepository(env.DB),
      serverRegistry: new CatalogServerRegistry(env, server),
      client: new StreamableHttpMcpDownstreamClient({
        credentials: new SecretBearerCredentials(env),
        fetch: serverFetch(env, server),
      }),
      guaranteeLevel: server.guaranteeLevel,
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    });
  }
  return executors;
}
