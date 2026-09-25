import { PREVIEW_TOKEN_HEADER } from "./access.ts";

const STORAGE_KEY = "ultra-easy.preview-harness-token";

export function readPreviewToken(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storePreviewToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // sessionStorageが使えない場合は入力欄の値だけを使う。
  }
}

/** preview harness APIを共有トークン付きで呼ぶ。 */
export function previewFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(PREVIEW_TOKEN_HEADER, readPreviewToken());
  return fetch(path, { ...init, headers });
}
