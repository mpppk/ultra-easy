import { Result } from "@praha/byethrow";

/**
 * Knowledge session: the trusted principal lives only in an encrypted,
 * HttpOnly, SameSite=Strict cookie (AES-GCM). Browser input never names the
 * actor / authority / organization.
 */
export const SESSION_COOKIE = "ue_knowledge_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type KnowledgeSession = { principalId: string; organizationId: string; expiresAt: number };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  const decoded = Result.try({
    try: () => atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    catch: () => null,
  });
  return Result.isSuccess(decoded)
    ? Uint8Array.from(decoded.value, (char) => char.charCodeAt(0))
    : null;
}

async function key(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(payload: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await key(secret),
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const sealed = new Uint8Array(iv.length + cipher.length);
  sealed.set(iv);
  sealed.set(cipher, iv.length);
  return base64Url(sealed);
}

async function open(value: string, secret: string): Promise<Record<string, unknown> | null> {
  const sealed = fromBase64Url(value);
  if (!sealed || sealed.length < 13) return null;
  const plain = await Result.try({
    try: async () =>
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.slice(0, 12) },
        await key(secret),
        sealed.slice(12),
      ),
    catch: () => null,
  });
  if (Result.isFailure(plain)) return null;
  const parsed = Result.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(plain.value)),
    catch: () => null,
  });
  if (Result.isFailure(parsed) || typeof parsed.value !== "object" || parsed.value === null)
    return null;
  return parsed.value as Record<string, unknown>;
}

export async function sealSession(
  session: Omit<KnowledgeSession, "expiresAt">,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const payload: KnowledgeSession = { ...session, expiresAt: nowMs + SESSION_TTL_SECONDS * 1000 };
  return seal(payload, secret);
}

export async function openSession(
  value: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<KnowledgeSession | null> {
  const session = await open(value, secret);
  if (
    !session ||
    typeof session.principalId !== "string" ||
    typeof session.organizationId !== "string" ||
    typeof session.expiresAt !== "number" ||
    session.expiresAt <= nowMs
  ) {
    return null;
  }
  return {
    principalId: session.principalId,
    organizationId: session.organizationId,
    expiresAt: session.expiresAt,
  };
}

/**
 * Auth0 login transaction (state / nonce / PKCE verifier / return path). It
 * rides the round trip through Auth0 in its own short-lived encrypted cookie,
 * scoped to `/api/auth` and SameSite=Lax because the callback is a cross-site
 * top-level redirect.
 */
export const LOGIN_TRANSACTION_COOKIE = "ue_knowledge_auth";
const LOGIN_TRANSACTION_TTL_SECONDS = 10 * 60;

export type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
};

export async function sealLoginTransaction(
  transaction: Omit<LoginTransaction, "expiresAt">,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return seal({ ...transaction, expiresAt: nowMs + LOGIN_TRANSACTION_TTL_SECONDS * 1000 }, secret);
}

export async function openLoginTransaction(
  value: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<LoginTransaction | null> {
  const transaction = await open(value, secret);
  if (
    !transaction ||
    typeof transaction.state !== "string" ||
    typeof transaction.nonce !== "string" ||
    typeof transaction.codeVerifier !== "string" ||
    typeof transaction.returnTo !== "string" ||
    typeof transaction.expiresAt !== "number" ||
    transaction.expiresAt <= nowMs
  ) {
    return null;
  }
  return {
    state: transaction.state,
    nonce: transaction.nonce,
    codeVerifier: transaction.codeVerifier,
    returnTo: transaction.returnTo,
    expiresAt: transaction.expiresAt,
  };
}

export function loginTransactionCookie(value: string): string {
  return `${LOGIN_TRANSACTION_COOKIE}=${value}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_TRANSACTION_TTL_SECONDS}`;
}

export function clearLoginTransactionCookie(): string {
  return `${LOGIN_TRANSACTION_COOKIE}=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Same-origin path to return to after sign-in (never an open redirect). */
export function safeReturnPath(value: string | null | undefined): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !value.startsWith("/api/")
    ? value
    : "/";
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Max-Age=0`;
}
