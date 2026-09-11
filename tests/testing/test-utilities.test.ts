import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { JsonValue, ResourceId } from "@app/approval-core";
import {
  canonicalizeJson,
  createDeterministicIdGenerator,
  createFixedClock,
} from "@app/approval-core/testing";

describe("M0 deterministic test utilities", () => {
  it("fixed clockは同じ時刻を返し続ける", () => {
    const result = createFixedClock("2026-09-11T00:00:00+09:00");

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.value.now()).toBe("2026-09-10T15:00:00.000Z");
    expect(result.value.now()).toBe("2026-09-10T15:00:00.000Z");
  });

  it("fixed clockは不正な時刻をFailureとして返す", () => {
    const result = createFixedClock("not-a-date");

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.error.message).toBe("不正な時刻です: not-a-date");
  });

  it("deterministic ID generatorは指定順にIDを返し、枯渇時にFailureを返す", () => {
    const first = "RESOURCE-001" as ResourceId;
    const second = "RESOURCE-002" as ResourceId;
    const generator = createDeterministicIdGenerator([first, second]);

    expect(generator.next()).toEqual(Result.succeed(first));
    expect(generator.next()).toEqual(Result.succeed(second));
    const exhausted = generator.next();
    expect(Result.isFailure(exhausted)).toBe(true);
    if (Result.isSuccess(exhausted)) return;
    expect(exhausted.error.message).toBe("deterministic IDを使い切りました");
  });

  it("canonical JSONはobject key順序に依存せず同じ文字列になる", () => {
    const left = {
      z: 1,
      a: { y: true, x: null },
    } satisfies JsonValue;
    const right = {
      a: { x: null, y: true },
      z: 1,
    } satisfies JsonValue;

    expect(canonicalizeJson(left)).toEqual(
      Result.succeed('{"a":{"x":null,"y":true},"z":1}'),
    );
    expect(canonicalizeJson(right)).toEqual(canonicalizeJson(left));
  });

  it("canonical JSONはUnicode normalizationを行わない", () => {
    expect(canonicalizeJson("é")).not.toEqual(canonicalizeJson("e\u0301"));
  });

  it("canonical JSONはJSON domain外のnumberを拒否する", () => {
    const result = canonicalizeJson(Number.NaN as JsonValue);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.error.message).toBe("NaNまたはInfinityはcanonical JSONにできません");
  });
});
