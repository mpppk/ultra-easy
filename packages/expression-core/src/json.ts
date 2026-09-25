export type JsonPrimitive = null | boolean | number | string;

export type JsonArray = JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 有限かつ（整数なら）安全に表現できる数値か。 */
export function isSafeJsonNumber(value: number): boolean {
  return Number.isFinite(value) && !(Number.isInteger(value) && !Number.isSafeInteger(value));
}

export type JsonValueIssue = "invalid_number" | "invalid_value";

/**
 * 実行時の値がJSONとして安全に表現できるかを検査する。
 * 非有限・安全でない整数はinvalid_number、plain object / array / primitive以外はinvalid_value。
 */
export function jsonValueIssue(value: unknown): JsonValueIssue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }

  if (typeof value === "number") {
    return isSafeJsonNumber(value) ? undefined : "invalid_number";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const issue = jsonValueIssue(item);
      if (issue) return issue;
    }
    return undefined;
  }

  if (isPlainRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) {
      const issue = jsonValueIssue(item);
      if (issue) return issue;
    }
    return undefined;
  }

  return "invalid_value";
}

/** JSONとして構造的に等しいか（objectのkey順序は問わない）。 */
export function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalJson(value, right[index] as JsonValue));
  }

  if (isPlainRecord(left)) {
    if (!isPlainRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) => equalJson(left[key] as JsonValue, right[key] as JsonValue));
  }

  return false;
}
