import { describe, expect, it } from "vitest";
import { handoffNotices } from "../src/devices/links";
// covers: devices.links.session, devices.handoff.machine

/*
 * What the handoff hears of a device link's sessions (WISP 06 § Frames): `handoff/1` agreed, lost, and agreed again
 * on a session that replaced the open one, which no data-link change says (the Linux bot, 2026-10-04: a request sent
 * on the replaced session was lost, and neither side said hello again).
 */
describe("the handoff and the device link's sessions", () => {
  it("hears handoff/1 agreed, and lost", () => {
    expect(handoffNotices({}, true, "s1")).toEqual([true]);
    expect(handoffNotices({ handoff: true, session: "s1" }, false, undefined)).toEqual([false]);
    expect(handoffNotices({}, false, undefined)).toEqual([]);
  });

  it("a new session in place of the open one: the old one ended and this one opened", () => {
    expect(handoffNotices({ handoff: true, session: "s1" }, true, "s2")).toEqual([false, true]);
  });

  it("the same session agreeing again says nothing", () => {
    expect(handoffNotices({ handoff: true, session: "s1" }, true, "s1")).toEqual([]);
  });
});
