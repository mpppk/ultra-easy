/**
 * Console session: the Auth0 access token lives only in an encrypted,
 * HttpOnly, SameSite=Strict cookie. Browser JavaScript never sees it (nor any
 * FGA credential); the web worker proxies API calls server-side.
 */
export const SESSION_COOKIE = "ue_console_session";

export type ConsoleSession = { accessToken: string; expiresAt: number };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function key(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSession(session: ConsoleSession, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await key(secret),
      new TextEncoder().encode(JSON.stringify(session)),
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
): Promise<ConsoleSession | null> {
  const sealed = fromBase64Url(value);
  if (!sealed || sealed.length < 13) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12) },
      await key(secret),
      sealed.slice(12),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Partial<ConsoleSession>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") return null;
    return parsed.expiresAt > nowMs
      ? { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
