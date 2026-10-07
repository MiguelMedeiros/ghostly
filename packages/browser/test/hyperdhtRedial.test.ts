import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_DIALS, PREFACE_MAX_WAIT_MS, PREFACE_WAIT_MS, prefaceWait, redial } from "../../../native/transports/hyperdht/redial.mjs";
// covers: transport.hyperdht

/**
 * The HyperDHT endpoint's dial (native/transports/hyperdht/redial.mjs). The first connection a freshly started process
 * makes sometimes opens and then carries nothing until UDX gives up (13 s), while the same dial made again goes
 * through at once: a chat moving to HyperDHT right after the contact's app restarted took about 28 s (bug hunt r11h).
 */

interface Bound { channel: { close(): void }; n: number }
interface Fake { opened: (open: boolean) => void; ready: (n: number) => void; fail: (error: Error) => void; closed: boolean; channel: { close: ReturnType<typeof vi.fn> } }

function dialer() {
  const dials: Fake[] = [];
  const dialOnce = () => {
    let opened!: (open: boolean) => void, ready!: (bound: Bound) => void, fail!: (error: Error) => void;
    const fake = { closed: false, channel: { close: vi.fn() } } as unknown as Fake;
    const dial = {
      opened: new Promise<boolean>((r) => { opened = r; }),
      ready: new Promise<Bound>((r, j) => { ready = r; fail = j; }),
      close: () => { fake.closed = true; fail(new Error("Native channel closed")); },
    };
    fake.opened = opened; fake.ready = (n) => ready({ channel: fake.channel, n }); fake.fail = (error) => fail(error);
    dials.push(fake);
    return dial;
  };
  return { dials, dialOnce };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("a dial that opened and brought no preface is made again, and the next one carries the connect", async () => {
  const { dials, dialOnce } = dialer();
  let result: Bound | undefined;
  void redial(dialOnce).then((bound) => { result = bound; });
  dials[0].opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS - 1);
  expect(dials).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(dials[0].closed).toBe(true);
  expect(dials).toHaveLength(2);
  dials[1].opened(true); dials[1].ready(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(result?.n).toBe(2);
});

it("a dial that brings its preface in time is the connect, with no second dial", async () => {
  const { dials, dialOnce } = dialer();
  const done = redial(dialOnce);
  dials[0].opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS / 2);
  dials[0].ready(1);
  expect((await done).n).toBe(1);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS * 5);
  expect(dials).toHaveLength(1);
  expect(dials[0].closed).toBe(false);
});

it("a dial that fails before it opened (the contact not found) fails the connect at once", async () => {
  const { dials, dialOnce } = dialer();
  const done = redial(dialOnce);
  dials[0].opened(false); dials[0].fail(new Error("PEER_NOT_FOUND"));
  await expect(done).rejects.toThrow("PEER_NOT_FOUND");
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS * 5);
  expect(dials).toHaveLength(1);
});

/** `dialOnce` whose streams report `sample.rtt` as their smoothed RTT, as UDX's `rawStream.rtt` does (0: no sample yet). */
function dialerWithRtt(rtt: number) {
  const made = dialer();
  const sample = { rtt };
  return { dials: made.dials, sample, dialOnce: () => ({ ...made.dialOnce(), rtt: () => sample.rtt }) };
}

it("on a 3 s path, before the stream's first RTT sample, the dial's slow opening keeps it from being made again", async () => {
  const { dials, dialOnce, sample } = dialerWithRtt(0);
  let result: Bound | undefined;
  void redial(dialOnce).then((bound) => { result = bound; });
  // The handshake took two round trips (the lookup, then the handshake through a DHT node).
  await vi.advanceTimersByTimeAsync(6000);
  dials[0].opened(true);
  // Our first packet is acknowledged one round trip after the stream opened; the contact's preface comes with it.
  await vi.advanceTimersByTimeAsync(2999);
  expect(dials).toHaveLength(1);
  sample.rtt = 3000;
  dials[0].ready(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(result?.n).toBe(1);
  expect(dials[0].closed).toBe(false);
});

it("on a 3 s path, a stream whose preface takes a round trip is not made again before the preface comes", async () => {
  const { dials, dialOnce } = dialerWithRtt(3000);
  let result: Bound | undefined;
  void redial(dialOnce).then((bound) => { result = bound; });
  dials[0].opened(true);
  await vi.advanceTimersByTimeAsync(4500);
  expect(dials).toHaveLength(1);
  expect(dials[0].closed).toBe(false);
  dials[0].ready(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(result?.n).toBe(1);
});

it("on a 3 s path, a stream that stays silent is made again once three round trips went by, at most 8 s", async () => {
  const { dials, dialOnce } = dialerWithRtt(3000);
  void redial(dialOnce).catch(() => {});
  dials[0].opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_MAX_WAIT_MS - 1);
  expect(dials).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(dials[0].closed).toBe(true);
  expect(dials).toHaveLength(2);
});

it("on a 100 ms path, a stream that stays silent is still made again after 2 s", async () => {
  const { dials, dialOnce } = dialerWithRtt(100);
  void redial(dialOnce).catch(() => {});
  dials[0].opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS - 1);
  expect(dials).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(dials[0].closed).toBe(true);
  expect(dials).toHaveLength(2);
});

it("the wait is three smoothed round trips, or twice the opening before a sample, between 2 s and 8 s", () => {
  expect(prefaceWait(0)).toBe(PREFACE_WAIT_MS);
  expect(prefaceWait(0, 20)).toBe(PREFACE_WAIT_MS);
  expect(prefaceWait(100)).toBe(PREFACE_WAIT_MS);
  expect(prefaceWait(1000)).toBe(3000);
  expect(prefaceWait(3000)).toBe(PREFACE_MAX_WAIT_MS);
  expect(prefaceWait(0, 1500)).toBe(3000);
  expect(prefaceWait(0, 6000)).toBe(PREFACE_MAX_WAIT_MS);
  // A sample replaces the opening: a stream that answers fast is back on the 2 s.
  expect(prefaceWait(100, 6000)).toBe(PREFACE_WAIT_MS);
});

it(`dials at most ${MAX_DIALS} times: the last one is waited for to its own end`, async () => {
  const { dials, dialOnce } = dialer();
  const done = redial(dialOnce);
  const failed = expect(done).rejects.toThrow("connection timed out");
  for (let i = 0; i < MAX_DIALS - 1; i++) {
    dials[i].opened(true);
    await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS);
    expect(dials[i].closed).toBe(true);
  }
  const last = dials[MAX_DIALS - 1];
  last.opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS * 5);
  expect(dials).toHaveLength(MAX_DIALS);
  expect(last.closed).toBe(false);
  last.fail(new Error("connection timed out"));
  await failed;
});
