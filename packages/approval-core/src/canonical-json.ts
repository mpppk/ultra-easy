import { Result } from "@praha/byethrow";

import type { Sha256Digest } from "./domain/brand.ts";
import type { JsonValue } from "./domain/json.ts";

export type CanonicalJsonError = {
  type: "canonical_json_error";
  code:
    | "invalid_unicode"
    | "serialization_failed"
    | "non_finite_number"
    | "non_plain_object"
    | "sha256_failed";
  message: string;
};

function fail(code: CanonicalJsonError["code"], message: string) {
  return Result.fail<CanonicalJsonError>({ type: "canonical_json_error", code, message });
}

function assertValidUnicode(value: string): Result.Result<void, CanonicalJsonError> {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return fail("invalid_unicode", "lone high surrogateを含む文字列はcanonical JSONにできません");
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return fail("invalid_unicode", "lone low surrogateを含む文字列はcanonical JSONにできません");
    }
  }
  return Result.succeed();
}

function serializeString(value: string): Result.Result<string, CanonicalJsonError> {
  const unicode = assertValidUnicode(value);
  if (Result.isFailure(unicode)) return unicode;

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return fail("serialization_failed", "文字列をJSONへ変換できませんでした");
  }
  return Result.succeed(serialized);
}

function serialize(value: JsonValue): Result.Result<string, CanonicalJsonError> {
  if (value === null) return Result.succeed("null");
  if (typeof value === "boolean") return Result.succeed(value ? "true" : "false");
  if (typeof value === "string") return serializeString(value);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail("non_finite_number", "NaNまたはInfinityはcanonical JSONにできません");
    }
    return Result.succeed(JSON.stringify(value));
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const serialized = serialize(item);
      if (Result.isFailure(serialized)) return serialized;
      items.push(serialized.value);
    }
    return Result.succeed(`[${items.join(",")}]`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("non_plain_object", "plain object以外はcanonical JSONにできません");
  }

  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const serializedKey = serializeString(key);
    if (Result.isFailure(serializedKey)) return serializedKey;
    const serializedValue = serialize(value[key] as JsonValue);
    if (Result.isFailure(serializedValue)) return serializedValue;
    entries.push(`${serializedKey.value}:${serializedValue.value}`);
  }
  return Result.succeed(`{${entries.join(",")}}`);
}

/** RFC 8785 (JCS)に従うcanonical JSON。追加のUnicode normalizationは行わない。 */
export function canonicalizeJson(value: JsonValue): Result.Result<string, CanonicalJsonError> {
  return serialize(value);
}

const digestText = Result.fn({
  try: async (value: string): Promise<Sha256Digest> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
    return `sha256:${hex}` as Sha256Digest;
  },
  catch: (): CanonicalJsonError => ({
    type: "canonical_json_error",
    code: "sha256_failed",
    message: "SHA-256 digestの計算に失敗しました",
  }),
});

export function sha256Text(value: string): Result.ResultAsync<Sha256Digest, CanonicalJsonError> {
  return digestText(value);
}

export async function sha256CanonicalJson(
  value: JsonValue,
): Result.ResultAsync<Sha256Digest, CanonicalJsonError> {
  const canonical = canonicalizeJson(value);
  if (Result.isFailure(canonical)) return canonical;
  return sha256Text(canonical.value);
}
