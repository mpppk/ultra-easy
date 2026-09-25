import {
  AuthorizationRelationshipCoordinator,
  AuthorizationRelationshipExecutor,
  type OrganizationId,
} from "@app/approval-core";
import { telemetrySinkFromEnv, type TelemetryEnv } from "@app/approval-runtime-cloudflare";
import { D1AuthorizationRelationshipStore, type D1DatabaseLike } from "@app/approval-d1";
import {
  DEFAULT_FGA_API_URL,
  OpenFgaClient,
  OpenFgaRelationshipTupleGateway,
  sharedFgaTokenProvider,
} from "@app/approval-fga";

export type RelationshipMutationEnv = TelemetryEnv & {
  DB: D1DatabaseLike;
  OPENFGA_API_URL?: string;
  OPENFGA_STORE_ID?: string;
  OPENFGA_AUTHORIZATION_MODEL_ID?: string;
  /**
   * Tuple-write credential for the relationship executor/reconciler only.
   * Falls back to FGA_CLIENT_ID/SECRET where a separate writer client has not
   * been provisioned yet (staging). Never exposed to the web app.
   */
  FGA_TUPLE_WRITER_CLIENT_ID?: string;
  FGA_TUPLE_WRITER_CLIENT_SECRET?: string;
  FGA_CLIENT_ID?: string;
  FGA_CLIENT_SECRET?: string;
  FGA_API_TOKEN_ISSUER?: string;
  FGA_API_AUDIENCE?: string;
};

function writerCredentials(env: RelationshipMutationEnv) {
  const clientId = env.FGA_TUPLE_WRITER_CLIENT_ID ?? env.FGA_CLIENT_ID;
  const clientSecret = env.FGA_TUPLE_WRITER_CLIENT_SECRET ?? env.FGA_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Composition root for the governed relationship mutation capability
 * (executor + reconciler). This is the only place a tuple-write capable FGA
 * client is constructed.
 */
export function relationshipCoordinator(
  env: RelationshipMutationEnv,
): AuthorizationRelationshipCoordinator | null {
  const credentials = writerCredentials(env);
  const storeId = env.OPENFGA_STORE_ID;
  const modelId = env.OPENFGA_AUTHORIZATION_MODEL_ID;
  if (!credentials || !storeId || !modelId) return null;
  // isolate内で共有し、tuple writeのたびにtoken exchangeしない（#90）。
  const tokenSupplier = sharedFgaTokenProvider({ ...env, ...credentials });
  return new AuthorizationRelationshipCoordinator({
    store: new D1AuthorizationRelationshipStore(env.DB),
    gateway: new OpenFgaRelationshipTupleGateway({
      authorizationModelId: modelId,
      clientFor: (organizationId: OrganizationId) =>
        new OpenFgaClient({
          apiUrl: env.OPENFGA_API_URL ?? DEFAULT_FGA_API_URL,
          storeId,
          authorizationModelId: modelId,
          organizationId,
          tokenSupplier,
          telemetry: telemetrySinkFromEnv(env),
        }),
    }),
    clock: { now: () => new Date().toISOString() },
  });
}

export function relationshipExecutor(
  env: RelationshipMutationEnv,
): AuthorizationRelationshipExecutor | null {
  const coordinator = relationshipCoordinator(env);
  return coordinator ? new AuthorizationRelationshipExecutor(coordinator) : null;
}
