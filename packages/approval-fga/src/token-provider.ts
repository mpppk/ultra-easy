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

function decodeExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const exp = (payload as Record<string, unknown>).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

async function exchangeToken(input: {
  fetchImplementation: typeof globalThis.fetch;
  url: string;
  body: string;
}): Result.ResultAsync<string, FgaTokenProviderError> {
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
  let parsed: { access_token?: unknown };
  try {
    parsed = (await response.json()) as { access_token?: unknown };
  } catch (error) {
    return fail("fga_token_malformed", false, String(error));
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    return fail("fga_token_malformed", false, "FGA token responseにaccess_tokenがありません");
  }
  return Result.succeed(parsed.access_token);
}

/**
 * Auth0 FGA client-credentials token provider with in-memory cache.
 * Workers isolate内で有効期限60秒前までtokenを使い回す。
 */
export class ClientCredentialsTokenProvider implements FgaAccessTokenSupplier {
  private cached: { token: string; exp: number } | null = null;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: FgaTokenProviderOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async getAccessToken(
    nowSeconds: number = Date.now() / 1000,
  ): Result.ResultAsync<string, FgaTokenProviderError> {
    const cached = this.cached;
    if (cached && cached.exp - 60 > nowSeconds) return Result.succeed(cached.token);
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
    const exp = decodeExp(exchanged.value) ?? nowSeconds + 300;
    this.cached = { token: exchanged.value, exp };
    return Result.succeed(exchanged.value);
  }
}
