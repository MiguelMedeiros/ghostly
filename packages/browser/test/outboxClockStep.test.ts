import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbox, RESEND_POLICY, type Resender } from "../src/engine/outbox";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.paired.offline-send, delivery.hold.text

const WIRE = "abcdefghijklmnopqrstuv", MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
afterEach(() => vi.useRealTimers());

/**
 * A text to a contact who is away, in an outbox whose wall clock the test sets (`step`), the way the device clock is
 * set by hand or by NTP; timers and the monotonic clock run on as before. `row`: what its row holds when it starts.
 */
function away(divert?: Resender["divert"], row: Partial<StoredMessage> = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  let offset = 0;
  const stored: StoredMessage = { linkId: "clock-step", id: `me_${WIRE}`, wireId: WIRE, text: "hello", sender: "me", timestamp: Date.now(), via: "datalink", delivery: "sending", ...row };
  const store = {
    read: async () => [{ ...stored }],
    update: async (_id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
      if (stored.delivery !== "delivered") Object.assign(stored, extra, { delivery, deliveryError: error });
    },
  };
  const box = new Outbox(store, async () => "You are offline.", 20_000, undefined,
    { resender: { ready: () => false, ...(divert && { divert }) }, now: () => Date.now() + offset });
  return { row: stored, box, step: (ms: number) => { offset += ms; } };
}

/** When the text was handed to store-and-forward, after the clock was stepped by `ms` 10 s after it was queued. */
async function handedOverAfter(ms: number): Promise<number | undefined> {
  let at: number | undefined;
  const t = away(async () => { at ??= performance.now() - start; return true; });
  const start = performance.now();
  await t.box.transmit(t.row.id);
  await vi.advanceTimersByTimeAsync(10_000);
  t.step(ms);
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  await t.box.stop();
  return at;
}

describe("a text queued for an away contact, when the device clock steps", () => {
  it("is handed to store-and-forward at its first check past a minute away", async () => {
    // Checks at 5, 20, 50 and 110 s.
    expect(await handedOverAfter(0)).toBe(110_000);
  });

  it.each([["an hour", 60 * MINUTE], ["a day", DAY]])("set back %s, is still handed over at its first check past a minute", async (_, ms) => {
    expect(await handedOverAfter(-ms)).toBe(110_000);
  });

  it("set forward 8 days, still goes within its week, and fails once a week has passed", async () => {
    const t = away();
    await t.box.transmit(t.row.id);
    expect(t.row.delivery).toBe("queued");
    await vi.advanceTimersByTimeAsync(10_000);
    t.step(8 * DAY);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.row.delivery).toBe("queued");
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs - 15 * MINUTE);
    expect(t.row.delivery).toBe("queued");
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(t.row).toMatchObject({ delivery: "failed", deliveryError: expect.stringContaining("Not confirmed within 7 days") });
    await t.box.stop();
  });

  it("set back 30 days, fails a week after, not 37 days after", async () => {
    const t = away();
    await t.box.transmit(t.row.id);
    const stamped = t.row.resendUntil;
    await vi.advanceTimersByTimeAsync(10_000);
    t.step(-30 * DAY);
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs - 15 * MINUTE);
    expect(t.row.delivery).toBe("queued");
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(t.row).toMatchObject({ delivery: "failed", deliveryError: expect.stringContaining("Not confirmed within 7 days") });
    // The row's deadline was never rewritten.
    expect(t.row.resendUntil).toBe(stamped);
    await t.box.stop();
  });

  it("a row queued while the clock ran 30 days ahead fails a week after the start that finds it", async () => {
    const t = away(undefined, { delivery: "queued", deliveryError: "Not confirmed yet.", resendUntil: Date.now() + 30 * DAY + RESEND_POLICY.windowMs });
    await t.box.recover();
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs - 15 * MINUTE);
    expect(t.row.delivery).toBe("queued");
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(t.row.delivery).toBe("failed");
    await t.box.stop();
  });
});
