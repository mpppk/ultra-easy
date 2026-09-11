import { describe, expect, it } from "vite-plus/test";

import type { JsonValue, ResourceId } from "../../packages/approval-core/src/domain/index.ts";
import {
  canonicalizeJson,
  createDeterministicIdGenerator,
  createFixedClock,
} from "../../packages/approval-core/src/testing/index.ts";

describe("M0 deterministic test utilities", () => {
  it("fixed clockは同じ時刻を返し続ける", () => {
    const clock = createFixedClock("2026-09-11T00:00:00+09:00");

    expect(clock.now()).toBe("2026-09-10T15:00:00.000Z");
    expect(clock.now()).toBe("2026-09-10T15:00:00.000Z");
  });

  it("deterministic ID generatorは指定順にIDを返し、枯渇時に失敗する", () => {
    const first = "RESOURCE-001" as ResourceId;
    const second = "RESOURCE-002" as ResourceId;
    const generator = createDeterministicIdGenerator([first, second]);

    expect(generator.next()).toBe(first);
    expect(generator.next()).toBe(second);
    expect(() => generator.next()).toThrow("deterministic IDを使い切りました");
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

    expect(canonicalizeJson(left)).toBe('{"a":{"x":null,"y":true},"z":1}');
    expect(canonicalizeJson(right)).toBe(canonicalizeJson(left));
  });

  it("canonical JSONはUnicode normalizationを行わない", () => {
    expect(canonicalizeJson("é")).not.toBe(canonicalizeJson("e\u0301"));
  });

  it("canonical JSONはJSON domain外のnumberを拒否する", () => {
    expect(() => canonicalizeJson(Number.NaN as JsonValue)).toThrow(
      "NaNまたはInfinityはcanonical JSONにできません",
    );
  });
});
