import { describe, expect, it } from "vite-plus/test";

import { checkPreviewAccess } from "./access.ts";

describe("#97 preview harness access", () => {
  it("harness無効は404、トークン未設定はfail closedで403", async () => {
    await expect(
      checkPreviewAccess({ enabled: false, expectedToken: "secret", presentedToken: "secret" }),
    ).resolves.toEqual({ type: "denied", status: 404, code: "preview_harness_disabled" });
    await expect(
      checkPreviewAccess({ enabled: true, expectedToken: undefined, presentedToken: "anything" }),
    ).resolves.toEqual({ type: "denied", status: 403, code: "preview_harness_locked" });
    await expect(
      checkPreviewAccess({ enabled: true, expectedToken: "  ", presentedToken: "" }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("トークンの欠落・不一致は401、一致だけ許可する", async () => {
    for (const presentedToken of [null, "", "wrong", "secret-but-longer"]) {
      await expect(
        checkPreviewAccess({ enabled: true, expectedToken: "secret", presentedToken }),
      ).resolves.toEqual({ type: "denied", status: 401, code: "preview_harness_token_invalid" });
    }
    await expect(
      checkPreviewAccess({ enabled: true, expectedToken: "secret", presentedToken: "secret" }),
    ).resolves.toEqual({ type: "allowed" });
  });
});
