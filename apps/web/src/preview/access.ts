/** preview harness APIへ共有トークンを渡すheader（#97）。 */
export const PREVIEW_TOKEN_HEADER = "x-preview-harness-token";

export type PreviewAccessDecision =
  | { type: "allowed" }
  | { type: "denied"; status: 401 | 403 | 404; code: string };

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** 長さに依存しない比較（SHA-256 digest同士をconstant-timeで比べる）。 */
async function sameToken(expected: string, presented: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(expected), digest(presented)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * preview harness APIの入口判定。harness無効は404、共有トークン（secret）未設定はfail closedで403、
 * トークン不一致・欠落は401。preview URLは公開されるため、任意userIdのDecisionや任意actorの
 * force-cancelを第三者に実行させない。
 */
export async function checkPreviewAccess(input: {
  enabled: boolean;
  expectedToken: string | undefined;
  presentedToken: string | null;
}): Promise<PreviewAccessDecision> {
  if (!input.enabled) return { type: "denied", status: 404, code: "preview_harness_disabled" };
  const expected = input.expectedToken?.trim() ?? "";
  if (expected.length === 0) {
    return { type: "denied", status: 403, code: "preview_harness_locked" };
  }
  const presented = input.presentedToken?.trim() ?? "";
  if (presented.length === 0 || !(await sameToken(expected, presented))) {
    return { type: "denied", status: 401, code: "preview_harness_token_invalid" };
  }
  return { type: "allowed" };
}
