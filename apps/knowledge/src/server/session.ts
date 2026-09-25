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

export async function sealSession(
  session: Omit<KnowledgeSession, "expiresAt">,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: KnowledgeSession = { ...session, expiresAt: nowMs + SESSION_TTL_SECONDS * 1000 };
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

export async function openSession(
  value: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<KnowledgeSession | null> {
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
  const session = parsed.value as Partial<KnowledgeSession>;
  if (
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
