// oxlint-disable-next-line vite-plus/prefer-vite-plus-imports -- vite-plus/test throws at runtime with the current Bun/Vite+ setup.
import { describe, expect, it } from "vitest";

describe("setup", () => {
  it("works", () => {
    expect(1 + 1).toBe(2);
  });
});
