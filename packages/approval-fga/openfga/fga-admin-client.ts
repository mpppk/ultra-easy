// Operator tooling shared by publish-model.ts / bootstrap-admins.ts (not bundled into workers).
// Credentials come from the environment only (1Password `ultra-easy` via `op run`), never files.
import { Result } from "@praha/byethrow";

import { ClientCredentialsTokenProvider } from "../src/token-provider.ts";

export type FgaToolEnv = {
  apiUrl: string;
  storeId: string;
  token: string;
};

export async function fgaToolEnv(): Promise<FgaToolEnv> {
  const apiUrl = process.env.OPENFGA_API_URL ?? "https://api.us1.fga.dev";
  const storeId = process.env.OPENFGA_STORE_ID;
  const clientId = process.env.FGA_CLIENT_ID;
  const clientSecret = process.env.FGA_CLIENT_SECRET;
  if (!storeId || !clientId || !clientSecret) {
    console.error("OPENFGA_STORE_ID / FGA_CLIENT_ID / FGA_CLIENT_SECRET are required");
    process.exit(1);
  }
  const token = await new ClientCredentialsTokenProvider({
    tokenUrl: process.env.FGA_TOKEN_URL ?? "https://auth.fga.dev/oauth/token",
    audience: process.env.FGA_API_AUDIENCE ?? "https://api.us1.fga.dev/",
    clientId,
    clientSecret,
  }).getAccessToken();
  if (Result.isFailure(token)) {
    console.error(`token exchange failed: ${token.error.code}`);
    process.exit(1);
  }
  return { apiUrl, storeId, token: token.value };
}

export async function fgaRequest(
  env: FgaToolEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${env.apiUrl}/stores/${env.storeId}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}
