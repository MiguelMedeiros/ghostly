import { describe, expect, it } from "vitest";
import { clockTime } from "../../lib/time";
import { heldTime } from "../heldTime";

// covers: chat.scroll

// Real timers on purpose: fake timers fake `Intl` too, and its formatter takes a time of 0 for "now".
describe("clockTime (the time beside a message)", () => {
  it("writes a time as toLocaleTimeString did, a time no date holds included", () => {
    const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
    // Its day period held to it as the app does (heldTime.ts); the same text where ICU puts a no-break space there.
    for (const at of [0, 1_700_000_000_000, 1_700_000_000_000 + 13 * 3_600_000 + 7 * 60_000, -86_400_000, 8.64e15]) {
      expect(clockTime(at)).toBe(heldTime(new Intl.DateTimeFormat([], options), at));
    }
    for (const at of [1e20, NaN, Infinity]) expect(clockTime(at)).toBe(new Date(at).toLocaleTimeString([], options));
  });
});
