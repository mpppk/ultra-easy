import { Result } from "@praha/byethrow";

import {
  AuthorizationAdminDependencyError,
  AuthorizationExplainService,
  createAuthorizationAdminHttpApi,
  type ActionRequestApplicationService,
  type AuthorizationAdminAccessChecker,
  type AuthorizationModelInspector,
  type AuthorizationRelationshipObserver,
  type AuthorizationTargetDescriber,
  type ExplorerActionCatalog,
} from "@app/approval-application";
import {
  AUTHORIZATION_ADMIN_RELATIONS,
  AUTHORIZATION_ADMIN_ROOT_OBJECT,
  AuthorizationProviderError,
  DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
  type OrganizationId,
} from "@app/approval-core";
import {
  D1AuthorizationRelationshipReadRepository,
  listPublishedActionDefinitions,
  type D1DatabaseLike,
} from "@app/approval-d1";
import {
  AUTHORIZATION_MODEL_SOURCE,
  AUTHORIZATION_MODEL_SOURCE_PATH,
  AUTHORIZATION_MODEL_TESTS_PATH,
  authorizationModelChecksum,
  DEFAULT_FGA_API_URL,
  fgaTokenSupplierFromEnv,
  normalizeAuthorizationModel,
  OpenFgaClient,
  tenantScopedOpenFgaObject,
  type FgaAccessTokenSupplier,
} from "@app/approval-fga";
import { ConsoleTelemetrySink } from "@app/approval-core";

import type { Auth0IdentityProvider } from "./auth0-identity.ts";
import { stagingActionRelation } from "./action-relations.ts";

export type AdminAuthorizationEnv = {
  DB: D1DatabaseLike;
  OPENFGA_API_URL?: string;
  OPENFGA_STORE_ID?: string;
  OPENFGA_AUTHORIZATION_MODEL_ID?: string;
  FGA_CLIENT_ID?: string;
  FGA_CLIENT_SECRET?: string;
  FGA_API_TOKEN_ISSUER?: string;
  FGA_API_AUDIENCE?: string;
  /** Git revision the deployed model was published from (optional, non-secret). */
  AUTHORIZATION_MODEL_SOURCE_REVISION?: string;
};

// One token cache per isolate: avoids a client-credentials exchange per request (#90).
function tokenSupplier(env: AdminAuthorizationEnv): FgaAccessTokenSupplier | null {
  return fgaTokenSupplierFromEnv(env);
}

/**
 * Read/inspection FGA client for the admin API. The admin read path only
 * uses check / readTuple / readAuthorizationModel; tuple writes happen solely
 * in the relationship executor/reconciler, and no model write exists.
 */
function readClient(env: AdminAuthorizationEnv, organizationId: OrganizationId) {
  const supplier = tokenSupplier(env);
  if (!env.OPENFGA_STORE_ID || !env.OPENFGA_AUTHORIZATION_MODEL_ID || !supplier) return null;
  return new OpenFgaClient({
    apiUrl: env.OPENFGA_API_URL ?? DEFAULT_FGA_API_URL,
    storeId: env.OPENFGA_STORE_ID,
    authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
    organizationId,
    tokenSupplier: supplier,
    telemetry: new ConsoleTelemetrySink(),
  });
}

function notConfigured(): AuthorizationProviderError {
  return new AuthorizationProviderError({
    provider: "openfga",
    code: "fga_not_configured",
    retriable: true,
    detail: "FGA接続設定がありません",
  });
}

/**
 * tenant-scoped `authorization_admin:root` のviewer / editor relationで運用者権限を判定する。
 * 管理Console・operator dashboard・Public Read APIのoperator閲覧で共有する。
 */
export function authorizationAdminAccessChecker(
  env: AdminAuthorizationEnv,
  organizationId: OrganizationId,
): AuthorizationAdminAccessChecker {
  const client = readClient(env, organizationId);
  return {
    async check({ caller, permission }) {
      if (!client || String(caller.organizationId) !== String(organizationId)) {
        return Result.fail(notConfigured());
      }
      const checked = await client.check({
        user: String(caller.principal.id),
        relation: String(AUTHORIZATION_ADMIN_RELATIONS[permission]),
        object: AUTHORIZATION_ADMIN_ROOT_OBJECT,
        consistency: "higher_consistency",
      });
      if (Result.isFailure(checked)) {
        return Result.fail(
          new AuthorizationProviderError({
            provider: "openfga",
            code: checked.error.code,
            retriable: checked.error.retriable,
            detail: checked.error.message,
          }),
        );
      }
      return checked;
    },
  };
}

export function buildAdminAuthorizationApi(input: {
  env: AdminAuthorizationEnv;
  identity: Auth0IdentityProvider;
  organizationId: OrganizationId;
  service: ActionRequestApplicationService;
}) {
  const { env, organizationId } = input;
  const client = readClient(env, organizationId);
  const modelId = env.OPENFGA_AUTHORIZATION_MODEL_ID ?? "";

  const accessChecker = authorizationAdminAccessChecker(env, organizationId);

  const describer: AuthorizationTargetDescriber = {
    describe({ organizationId: org, action }) {
      const relation = stagingActionRelation(action);
      if (!relation) return null;
      const logicalObject = `${String(action.resource.type)}:${String(action.resource.id)}`;
      return {
        relation: String(relation),
        logicalObject,
        providerObject: tenantScopedOpenFgaObject(org, logicalObject),
        authorizationModelId: modelId,
      };
    },
    providerObject: ({ organizationId: org, logicalObject }) =>
      tenantScopedOpenFgaObject(org, logicalObject),
  };

  const modelInspector: AuthorizationModelInspector = {
    async inspect() {
      if (!client) {
        return Result.fail(
          new AuthorizationAdminDependencyError("fga_not_configured", true, "FGA未設定です"),
        );
      }
      const read = await client.readAuthorizationModel();
      if (Result.isFailure(read)) {
        return Result.fail(
          new AuthorizationAdminDependencyError(
            read.error.code,
            read.error.retriable,
            "model read failed",
          ),
        );
      }
      const provider = normalizeAuthorizationModel(read.value.model);
      const source = normalizeAuthorizationModel(AUTHORIZATION_MODEL_SOURCE);
      if (!provider || !source) {
        return Result.fail(
          new AuthorizationAdminDependencyError("invalid_model", false, "modelを正規化できません"),
        );
      }
      const [providerChecksum, sourceChecksum] = await Promise.all([
        authorizationModelChecksum(provider),
        authorizationModelChecksum(source),
      ]);
      if (Result.isFailure(providerChecksum) || Result.isFailure(sourceChecksum)) {
        return Result.fail(
          new AuthorizationAdminDependencyError("model_checksum_failed", false, "checksum failed"),
        );
      }
      return Result.succeed({
        activeModelId: read.value.id,
        provider: { apiHost: client.providerSummary.apiHost, storeId: client.storeId },
        schemaVersion: provider.schemaVersion,
        typeDefinitions: provider.typeDefinitions,
        conditions: provider.conditions,
        providerChecksum: providerChecksum.value,
        source: {
          path: AUTHORIZATION_MODEL_SOURCE_PATH,
          testsPath: AUTHORIZATION_MODEL_TESTS_PATH,
          checksum: sourceChecksum.value,
          matchesProvider: providerChecksum.value === sourceChecksum.value,
          revision: env.AUTHORIZATION_MODEL_SOURCE_REVISION?.trim() || null,
        },
        readOnly: true as const,
      });
    },
  };

  const observer: AuthorizationRelationshipObserver = {
    async observe({ organizationId: org, tuple }) {
      const scoped = readClient(env, org);
      if (!scoped) {
        return Result.fail(
          new AuthorizationAdminDependencyError("fga_not_configured", true, "FGA未設定です"),
        );
      }
      const read = await scoped.readTuple({ tuple, consistency: "higher_consistency" });
      return Result.isFailure(read)
        ? Result.fail(
            new AuthorizationAdminDependencyError(
              read.error.code,
              read.error.retriable,
              "read failed",
            ),
          )
        : Result.succeed({ present: read.value });
    },
  };

  const actionCatalog: ExplorerActionCatalog = {
    async list({ organizationId: org }) {
      const definitions = await listPublishedActionDefinitions(env.DB, org);
      if (Result.isFailure(definitions)) {
        return Result.fail(
          new AuthorizationAdminDependencyError(
            definitions.error.code,
            definitions.error.retriable,
            definitions.error.message,
          ),
        );
      }
      return Result.succeed(
        definitions.value.map((definition) => ({
          actionType: String(definition.actionType),
          executorKey: String(definition.executorKey),
          schemaKey: String(definition.inputSchema.key),
        })),
      );
    },
  };

  return createAuthorizationAdminHttpApi({
    callerResolver: input.identity,
    accessChecker,
    explainService: new AuthorizationExplainService({
      service: input.service,
      describer,
      clock: { now: () => new Date().toISOString() },
    }),
    relationships: new D1AuthorizationRelationshipReadRepository(env.DB),
    describer,
    modelInspector,
    catalog: DEFAULT_MANAGED_RELATIONSHIP_CATALOG,
    observer,
    actionCatalog,
    provider: {
      apiHost: new URL(env.OPENFGA_API_URL ?? DEFAULT_FGA_API_URL).host,
      storeId: env.OPENFGA_STORE_ID ?? "",
      authorizationModelId: modelId,
    },
  });
}
