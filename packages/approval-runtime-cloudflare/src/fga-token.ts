import { ClientCredentialsTokenProvider, type FgaAccessTokenSupplier } from "@app/approval-fga";

/** OpenFGA Cloudのclient credentials既定値。self-host / 別regionはenvで上書きする（#90）。 */
export const DEFAULT_FGA_TOKEN_ISSUER = "https://auth.fga.dev/oauth/token";
export const DEFAULT_FGA_API_AUDIENCE = "https://api.us1.fga.dev/";

const tokenProviders = new Map<string, ClientCredentialsTokenProvider>();

/**
 * isolate内で共有するFGA access token provider（#90）。client ID / token URL / audienceごとに
 * 1つだけ作り、tokenの有効期限まで再利用する（リクエスト・Workflow stepごとにexchangeしない）。
 */
export function fgaTokenSupplier(env: {
  FGA_CLIENT_ID?: string;
  FGA_CLIENT_SECRET?: string;
  FGA_API_TOKEN_ISSUER?: string;
  FGA_API_AUDIENCE?: string;
}): FgaAccessTokenSupplier | null {
  if (!env.FGA_CLIENT_ID || !env.FGA_CLIENT_SECRET) return null;
  const tokenUrl = env.FGA_API_TOKEN_ISSUER?.trim() || DEFAULT_FGA_TOKEN_ISSUER;
  const audience = env.FGA_API_AUDIENCE?.trim() || DEFAULT_FGA_API_AUDIENCE;
  const key = JSON.stringify([env.FGA_CLIENT_ID, tokenUrl, audience]);
  const cached = tokenProviders.get(key);
  if (cached) return cached;
  const created = new ClientCredentialsTokenProvider({
    tokenUrl,
    audience,
    clientId: env.FGA_CLIENT_ID,
    clientSecret: env.FGA_CLIENT_SECRET,
  });
  tokenProviders.set(key, created);
  return created;
}
