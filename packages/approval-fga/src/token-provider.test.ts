import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { ClientCredentialsTokenProvider } from "./token-provider.ts";

function unsignedToken(exp: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp })}.signature`;
}

describe("ClientCredentialsTokenProvider", () => {
  it("tokenをキャッシュして使い回す", async () => {
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: "https://auth.example.invalid/oauth/token",
      audience: "https://api.example.invalid/",
      clientId: "client",
      clientSecret: "secret",
      fetch: (async () => {
        calls += 1;
        const token = unsignedToken(Math.floor(Date.now() / 1000) + 3600);
        return Response.json({ access_token: token });
      }) as typeof globalThis.fetch,
    });
    const first = await provider.getAccessToken();
    const second = await provider.getAccessToken();
    if (Result.isFailure(first) || Result.isFailure(second)) {
      expect.unreachable("token exchange should succeed");
    }
    expect(first.value).toBe(second.value);
    expect(calls).toBe(1);
  });

  it("交換失敗をResultで返す", async () => {
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: "https://auth.example.invalid/oauth/token",
      audience: "https://api.example.invalid/",
      clientId: "client",
      clientSecret: "secret",
      fetch: (async () => new Response("unauthorized", { status: 401 })) as typeof globalThis.fetch,
    });
    const result = await provider.getAccessToken();
    expect(Result.isFailure(result)).toBe(true);
  });
});
