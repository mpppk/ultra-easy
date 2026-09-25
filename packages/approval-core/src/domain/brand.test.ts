import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  InvalidBrandValueError,
  MAX_BRAND_VALUE_LENGTH,
  approvalTaskIdOf,
  brandLiteral,
  parseBrand,
  parseBrands,
  type ActionRequestId,
  type MaterializedStepId,
  type OrganizationId,
} from "./brand.ts";

describe("#102 branded type smart constructors", () => {
  it("parseBrandは空文字・非string・長すぎる値・制御文字を拒否する", () => {
    for (const value of [
      "",
      42,
      null,
      undefined,
      "x".repeat(MAX_BRAND_VALUE_LENGTH + 1),
      "a\nb",
      "a\u0000b",
    ]) {
      const parsed = parseBrand("OrganizationId", value);
      assert(Result.isFailure(parsed), String(value));
      expect(parsed.error).toBeInstanceOf(InvalidBrandValueError);
      expect(parsed.error).toMatchObject({ code: "invalid_brand_value", kind: "OrganizationId" });
    }
  });

  it("parseBrandは妥当な識別子をそのままbrandにする", () => {
    const parsed = parseBrand("UserId", "user:auth0|6ab12807");
    assert(Result.isSuccess(parsed));
    expect(parsed.value).toBe("user:auth0|6ab12807");
    const many = parseBrands("UserId", ["user:a", "user:b"]);
    assert(Result.isSuccess(many));
    expect(many.value).toEqual(["user:a", "user:b"]);
    expect(Result.isFailure(parseBrands("UserId", ["user:a", ""]))).toBe(true);
  });

  it("brandLiteralはstring literalだけを受け付ける（外部入力のstringはcompile error）", () => {
    const organizationId: OrganizationId = brandLiteral("OrganizationId", "organization:test");
    expect(organizationId).toBe("organization:test");
    const external: string = "organization:from-request";
    // @ts-expect-error -- string型の値はbrandLiteralへ渡せない（parseBrandを使う）
    brandLiteral("OrganizationId", external);
  });

  it("導出IDはbrand.tsのconstructorで作る", () => {
    expect(approvalTaskIdOf("action:1" as ActionRequestId, "mstep:abc" as MaterializedStepId)).toBe(
      "task:action:1:mstep:abc",
    );
  });
});
