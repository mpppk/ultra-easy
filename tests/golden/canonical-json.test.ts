import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizeJson, sha256CanonicalJson } from "@app/approval-core";

const fixtureA = {
  nested: { z: "é", y: [3, 2, 1] },
  b: 1,
  a: 2,
};

const fixtureB = {
  a: 2,
  b: 1,
  nested: { y: [3, 2, 1], z: "é" },
};

describe("M2 canonical JSON golden", () => {
  it("AC-M2-005: key orderが違ってもRFC 8785 + SHA-256のgolden値が一致する", async () => {
    const canonical = Result.succeed('{"a":2,"b":1,"nested":{"y":[3,2,1],"z":"é"}}');
    const checksum = Result.succeed(
      "sha256:898cdb6cfb279ec51ccc201894d39b3657babfef443dc8415fd77cab61342218",
    );

    expect(canonicalizeJson(fixtureA)).toEqual(canonical);
    expect(canonicalizeJson(fixtureB)).toEqual(canonical);
    await expect(sha256CanonicalJson(fixtureA)).resolves.toEqual(checksum);
    await expect(sha256CanonicalJson(fixtureB)).resolves.toEqual(checksum);
  });
});
