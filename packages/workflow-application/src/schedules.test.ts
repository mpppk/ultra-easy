import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { nextScheduleSlot } from "./schedules.ts";

describe("nextScheduleSlot", () => {
  it("uses UTC and advances to the next weekly minute", () => {
    const next = nextScheduleSlot("0 0 * * 1", "2026-10-03T02:00:00.000Z");
    expect(Result.isSuccess(next) && next.value).toBe("2026-10-05T00:00:00.000Z");
  });

  it("rejects six-field and malformed expressions", () => {
    expect(Result.isFailure(nextScheduleSlot("0 0 0 * * 1", "2026-10-03T02:00:00.000Z"))).toBe(
      true,
    );
    expect(
      Result.isFailure(nextScheduleSlot("not a cron expression", "2026-10-03T02:00:00.000Z")),
    ).toBe(true);
  });
});
