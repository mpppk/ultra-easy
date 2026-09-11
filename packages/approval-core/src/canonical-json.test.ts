import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizeJson, sha256CanonicalJson } from "./canonical-json.ts";

const first = {
  nested: { z: "é", y: [3, 2, 1] },
  b: 1,
  a: 2,
};

const reordered = {
  a: 2,
  b: 1,
  nested: { y: [3, 2, 1], z: "é" },
};

describe("canonical JSON", () => {
  it("object key orderに依存せず同じRFC 8785表現になる", () => {
    const expected = Result.succeed('{"a":2,"b":1,"nested":{"y":[3,2,1],"z":"é"}}');

    expect(canonicalizeJson(first)).toEqual(expected);
    expect(canonicalizeJson(reordered)).toEqual(expected);
  });

  it("golden SHA-256をsha256:lowercase-hex形式で固定する", async () => {
    const expected = Result.succeed(
      "sha256:898cdb6cfb279ec51ccc201894d39b3657babfef443dc8415fd77cab61342218",
    );

    await expect(sha256CanonicalJson(first)).resolves.toEqual(expected);
    await expect(sha256CanonicalJson(reordered)).resolves.toEqual(expected);
  });

  it("Unicode normalizationは暗黙に行わない", () => {
    expect(canonicalizeJson({ value: "é" })).not.toEqual(
      canonicalizeJson({ value: "é" }),
    );
  });

  it("ECMAScript/JCSの数値表現としてnegative zeroを0へ正規化する", () => {
    expect(canonicalizeJson({ value: -0 })).toEqual(Result.succeed('{"value":0}'));
  });

  it("指数表記をECMAScriptのJSON number serializationで固定する", () => {
    expect(canonicalizeJson({ large: 1e30, small: 1e-7 })).toEqual(
      Result.succeed('{"large":1e+30,"small":1e-7}'),
    );
  });

  it("control文字・quote・backslashのescapeを固定する", () => {
    expect(canonicalizeJson({ value: '\b\t\n\f\r"\\' })).toEqual(
      Result.succeed('{"value":"\\b\\t\\n\\f\\r\\\"\\\\"}'),
    );
  });
});
