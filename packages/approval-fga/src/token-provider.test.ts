import { Result } from "@praha/byethrow";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClientCredentialsTokenProvider,
  decodeJwtExp,
  fgaTokenEndpoint,
  fgaTokenSupplierFromEnv,
  sharedFgaTokenProvider,
} from "./token-provider.ts";

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

  it("同時に来たrefreshを1回のtoken exchangeへまとめる", async () => {
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: "https://auth.example.invalid/oauth/token",
      audience: "https://api.example.invalid/",
      clientId: "client",
      clientSecret: "secret",
      fetch: (async () => {
        calls += 1;
        return Response.json({ access_token: unsignedToken(Math.floor(Date.now() / 1000) + 3600) });
      }) as typeof globalThis.fetch,
    });
    const results = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect(results.every((result) => Result.isSuccess(result))).toBe(true);
    expect(calls).toBe(1);
  });

  it("opaque tokenはexpires_inから有効期限を決める", async () => {
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: "https://auth.example.invalid/oauth/token",
      audience: "https://api.example.invalid/",
      clientId: "client",
      clientSecret: "secret",
      fetch: (async () => {
        calls += 1;
        return Response.json({ access_token: `opaque-${calls}`, expires_in: 3600 });
      }) as typeof globalThis.fetch,
    });
    const now = 1_800_000_000;
    await provider.getAccessToken(now);
    // 300秒fallbackなら取り直しになる時刻でもcacheを使う
    const cached = await provider.getAccessToken(now + 1_000);
    expect(cached).toEqual(Result.succeed("opaque-1"));
    expect(calls).toBe(1);
    const refreshed = await provider.getAccessToken(now + 3_550);
    expect(refreshed).toEqual(Result.succeed("opaque-2"));
  });
});

describe("decodeJwtExp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Bufferが無いWorkers（nodejs_compat無し）でもatobでexpを読む", () => {
    const token = unsignedToken(1_900_000_000);
    vi.stubGlobal("Buffer", undefined);
    expect(decodeJwtExp(token)).toBe(1_900_000_000);
    expect(decodeJwtExp("not-a-jwt")).toBeNull();
  });
});

describe("shared FGA token provider (#90)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("token endpointとaudienceはenvで上書きでき、既定のaudienceはOPENFGA_API_URLに連動する", () => {
    expect(fgaTokenEndpoint({})).toEqual({
      tokenUrl: "https://auth.fga.dev/oauth/token",
      audience: "https://api.us1.fga.dev/",
    });
    expect(fgaTokenEndpoint({ OPENFGA_API_URL: "https://api.eu1.fga.dev" })).toEqual({
      tokenUrl: "https://auth.fga.dev/oauth/token",
      audience: "https://api.eu1.fga.dev/",
    });
    expect(
      fgaTokenEndpoint({
        FGA_API_TOKEN_ISSUER: "https://issuer.example/token",
        FGA_API_AUDIENCE: "https://fga.example/",
      }),
    ).toEqual({ tokenUrl: "https://issuer.example/token", audience: "https://fga.example/" });
  });

  it("同一isolateの連続したリクエストでtoken exchangeは1回だけ", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return Response.json({ access_token: unsignedToken(Math.floor(Date.now() / 1000) + 3600) });
    });
    const env = { FGA_CLIENT_ID: "client-isolate", FGA_CLIENT_SECRET: "secret" };
    // リクエストごとにenvからsupplierを取り直しても、同じproviderとtoken cacheを使う
    for (let request = 0; request < 3; request += 1) {
      const supplier = fgaTokenSupplierFromEnv({ ...env });
      expect(Result.isSuccess(await supplier!.getAccessToken())).toBe(true);
    }
    expect(calls).toBe(1);
    expect(fgaTokenSupplierFromEnv(env)).toBe(
      sharedFgaTokenProvider({ clientId: "client-isolate", clientSecret: "secret" }),
    );
    expect(fgaTokenSupplierFromEnv({ ...env, FGA_CLIENT_SECRET: "rotated" })).not.toBe(
      fgaTokenSupplierFromEnv(env),
    );
    expect(fgaTokenSupplierFromEnv({ FGA_CLIENT_ID: "client-isolate" })).toBeNull();
  });
});
