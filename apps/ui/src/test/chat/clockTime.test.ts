import { describe, expect, it } from "vitest";
import { clockTime } from "../../lib/time";

// covers: chat.scroll

// Real timers on purpose: fake timers fake `Intl` too, and its formatter takes a time of 0 for "now".
describe("clockTime (the time beside a message)", () => {
  it("writes a time as toLocaleTimeString did, a time no date holds included", () => {
    for (const at of [0, 1_700_000_000_000, 1_700_000_000_000 + 13 * 3_600_000 + 7 * 60_000, -86_400_000, 8.64e15, 1e20, NaN, Infinity]) {
      expect(clockTime(at)).toBe(new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }
  });
});
