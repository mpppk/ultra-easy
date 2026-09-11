import type { JsonValue } from "../domain/json.ts";

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("lone high surrogateを含む文字列はcanonical JSONにできません");
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("lone low surrogateを含む文字列はcanonical JSONにできません");
    }
  }
}

function serializeString(value: string): string {
  assertValidUnicode(value);
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new Error("文字列をJSONへ変換できませんでした");
  }

  return serialized;
}

function serialize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "string") {
    return serializeString(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("NaNまたはInfinityはcanonical JSONにできません");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("plain object以外はcanonical JSONにできません");
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${serializeString(key)}:${serialize(value[key] as JsonValue)}`);

  return `{${entries.join(",")}}`;
}

/**
 * RFC 8785 (JSON Canonicalization Scheme)で要求される性質に合わせ、
 * object keyを決定的に並べたJSON文字列を生成するテストutility。
 * Unicode normalizationは行わない。
 */
export function canonicalizeJson(value: JsonValue): string {
  return serialize(value);
}
