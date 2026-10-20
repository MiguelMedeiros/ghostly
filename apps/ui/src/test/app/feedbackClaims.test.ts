import { afterEach, describe, expect, it, vi } from "vitest";

const CLAIM = "ghostly_feedback_claim:";
const claims = () => Object.keys(localStorage).filter((key) => key.startsWith(CLAIM));
/** A fresh page: the module's claim counter starts again. */
async function start() {
  vi.resetModules();
  return (await import("../../lib/feedbackClaims")).claimFeedback;
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("attention claims", () => {
  it("are kept only while they are needed, however few events each start has", async () => {
    const day = 86_400_000;
    let now = 1_800_000_000_000;
    for (let s = 0; s < 20; s++) {
      const claimFeedback = await start();
      for (let i = 0; i < 20; i++) expect(claimFeedback(`start-${s}-event-${i}`, now + i)).toBe(true);
      now += day;
    }
    // Before: every quiet start (fewer than 64 events) left all of its claims, 400 here.
    expect(claims().length).toBeLessThanOrEqual(20);
  });

  it("drops the old claims reading localStorage forwards, once", async () => {
    for (let i = 0; i < 500; i++) localStorage.setItem(`${CLAIM}old-${i}`, "1");
    for (let i = 0; i < 50; i++) localStorage.setItem(`other-${i}`, "x");
    const claimFeedback = await start();
    const read = vi.spyOn(localStorage, "key");
    // 64 claims: one sweep, before and after.
    for (let i = 0; i < 64; i++) claimFeedback(`fresh-${i}`, 1_800_000_000_000 + i);
    // WebKit's key(i) starts over whenever i goes down or the map changed: backwards with removes is quadratic.
    const indexes = read.mock.calls.map(([i]) => i);
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every((index, n) => n === 0 || index > indexes[n - 1])).toBe(true);
    expect(indexes.length).toBeLessThanOrEqual(551);
    expect(claims().filter((key) => key.includes("old-"))).toHaveLength(0);
    expect(claims()).toHaveLength(64);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("other-"))).toHaveLength(50);
  });
});
