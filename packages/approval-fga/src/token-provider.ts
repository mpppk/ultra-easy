import { Result } from "@praha/byethrow";

export class FgaTokenProviderError extends Error {
  override readonly name = "FgaTokenProviderError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type FgaTokenProviderOptions = {
  tokenUrl: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
};

export interface FgaAccessTokenSupplier {
  getAccessToken(): Result.ResultAsync<string, FgaTokenProviderError>;
}

function fail(
  code: string,
  retriable: boolean,
  message: string,
): Result.Result<never, FgaTokenProviderError> {
  return Result.fail(new FgaTokenProviderError(code, retriable, message));
}

/** base64url → UTF-8。Workers標準の`atob`だけを使う（nodejs_compat無しでは`Buffer`が無い）。 */
function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const exp = (payload as Record<string, unknown>).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

type ExchangedToken = { token: string; expiresIn: number | null };

async function exchangeToken(input: {
  fetchImplementation: typeof globalThis.fetch;
  url: string;
  body: string;
}): Result.ResultAsync<ExchangedToken, FgaTokenProviderError> {
  let response: Response;
  try {
    response = await input.fetchImplementation(input.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input.body,
    });
  } catch (error) {
    return fail("fga_token_failed", true, String(error));
  }
  if (!response.ok) {
    return fail(
      "fga_token_exchange_failed",
      response.status === 429 || response.status >= 500,
      `FGA token exchange failed: HTTP ${response.status}`,
    );
  }
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  } catch (error) {
    return fail("fga_token_malformed", false, String(error));
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    return fail("fga_token_malformed", false, "FGA token responseにaccess_tokenがありません");
  }
  return Result.succeed({
    token: parsed.access_token,
    expiresIn:
      typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : null,
  });
}

/**
 * Auth0 FGA client-credentials token provider with in-memory cache.
 * Workers isolate内で有効期限60秒前までtokenを使い回し、同時に来たrefreshは1回のexchangeへまとめる。
 * isolate内で共有するには`sharedFgaTokenProvider`を使う（#90）。
 */
export class ClientCredentialsTokenProvider implements FgaAccessTokenSupplier {
  private cached: { token: string; exp: number } | null = null;
  private inflight: Result.ResultAsync<string, FgaTokenProviderError> | null = null;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: FgaTokenProviderOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async getAccessToken(
    nowSeconds: number = Date.now() / 1000,
  ): Result.ResultAsync<string, FgaTokenProviderError> {
    const cached = this.cached;
    if (cached && cached.exp - 60 > nowSeconds) return Result.succeed(cached.token);
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh(nowSeconds).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(nowSeconds: number): Result.ResultAsync<string, FgaTokenProviderError> {
    const exchanged = await exchangeToken({
      fetchImplementation: this.fetchImplementation,
      url: this.options.tokenUrl,
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        audience: this.options.audience,
        grant_type: "client_credentials",
      }),
    });
    if (Result.isFailure(exchanged)) return exchanged;
    const { token, expiresIn } = exchanged.value;
    const exp = decodeJwtExp(token) ?? (expiresIn !== null ? nowSeconds + expiresIn : null);
    this.cached = { token, exp: exp ?? nowSeconds + 300 };
    return Result.succeed(token);
  }
}

/** OpenFGA Cloud（Auth0 FGA）の既定値。self-host / 別regionはenvで上書きする。 */
export const DEFAULT_FGA_API_URL = "https://api.us1.fga.dev";
export const DEFAULT_FGA_TOKEN_ISSUER = "auth.fga.dev";

/** FGA client credentialsの設定（Workers env / process.envの共通部分）。 */
export type FgaClientCredentialsEnv = {
  OPENFGA_API_URL?: string;
  /** token issuer。host（`auth.fga.dev`）またはtoken endpointのURL。 */
  FGA_API_TOKEN_ISSUER?: string;
  /** token audience。未設定は`OPENFGA_API_URL`のoriginから導く。 */
  FGA_API_AUDIENCE?: string;
};

/** envからtoken endpointとaudienceを決める。audienceはOPENFGA_API_URLに連動させる（#90）。 */
export function fgaTokenEndpoint(env: FgaClientCredentialsEnv): {
  tokenUrl: string;
  audience: string;
} {
  const issuer = env.FGA_API_TOKEN_ISSUER?.trim() || DEFAULT_FGA_TOKEN_ISSUER;
  const tokenUrl = /^https?:\/\//.test(issuer)
    ? issuer
    : `https://${issuer.replace(/\/+$/, "")}/oauth/token`;
  const explicitAudience = env.FGA_API_AUDIENCE?.trim();
  if (explicitAudience) return { tokenUrl, audience: explicitAudience };
  const apiUrl = env.OPENFGA_API_URL?.trim() || DEFAULT_FGA_API_URL;
  return { tokenUrl, audience: `${new URL(apiUrl).origin}/` };
}

const sharedProviders = new Map<string, ClientCredentialsTokenProvider>();

/**
 * isolate（module scope）で共有するtoken provider（#90）。client / secret / endpoint / audienceが
 * 同じ限り、リクエストやWorkflow stepをまたいで同じinstanceを返し、token exchangeを1回にする。
 * secretのrotation後は別keyになるため、新しいsecretで取り直す。
 */
export function sharedFgaTokenProvider(
  input: { clientId: string; clientSecret: string } & FgaClientCredentialsEnv,
  fetchImplementation?: typeof globalThis.fetch,
): ClientCredentialsTokenProvider {
  const endpoint = fgaTokenEndpoint(input);
  const key = JSON.stringify([
    input.clientId,
    input.clientSecret,
    endpoint.tokenUrl,
    endpoint.audience,
  ]);
  const cached = sharedProviders.get(key);
  if (cached) return cached;
  const created = new ClientCredentialsTokenProvider({
    ...endpoint,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
  sharedProviders.set(key, created);
  return created;
}

/** `FGA_CLIENT_ID` / `FGA_CLIENT_SECRET`からの共有token provider。未設定ならnull。 */
export function fgaTokenSupplierFromEnv(
  env: FgaClientCredentialsEnv & { FGA_CLIENT_ID?: string; FGA_CLIENT_SECRET?: string },
): ClientCredentialsTokenProvider | null {
  if (!env.FGA_CLIENT_ID || !env.FGA_CLIENT_SECRET) return null;
  return sharedFgaTokenProvider({
    ...env,
    clientId: env.FGA_CLIENT_ID,
    clientSecret: env.FGA_CLIENT_SECRET,
  });
}
