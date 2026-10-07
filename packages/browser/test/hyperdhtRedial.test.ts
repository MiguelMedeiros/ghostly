import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_DIALS, PREFACE_WAIT_MS, redial } from "../../../native/transports/hyperdht/redial.mjs";
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

it(`dials at most ${MAX_DIALS} times: the last one is waited for to its own end`, async () => {
  const { dials, dialOnce } = dialer();
  const done = redial(dialOnce);
  const failed = expect(done).rejects.toThrow("connection timed out");
  dials[0].opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS);
  dials[1].opened(true);
  await vi.advanceTimersByTimeAsync(PREFACE_WAIT_MS * 5);
  expect(dials).toHaveLength(MAX_DIALS);
  expect(dials[1].closed).toBe(false);
  dials[1].fail(new Error("connection timed out"));
  await failed;
});
