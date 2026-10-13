import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery, emptyDhtDeliveryState } from "../src/dhtDelivery";
import { AWAITING_PEER_MS, LinkSession, RELAY_POLL_INTERVALS, UNUSED_INVITE_WAIT_MAX_MS, type LinkSessionOptions } from "../src/link";
import type { PkarrTransport } from "../src/transport";
// covers: invite.create, core.relay-client

/**
 * Invites nobody used kept reading the relays at the background pace for as long as the app ran: 15 of them, their
 * keys and their mailboxes, spent both relays' whole minute (bug hunt 1013-1642). Once no longer awaited, an unused
 * invite is read less often the older it is.
 */
const NOW = 1_800_000_000_000;
const I = RELAY_POLL_INTERVALS;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => void vi.useRealTimers());

function counting() {
  const reads: number[] = [];
  const transport: PkarrTransport = {
    publish: async () => {},
    resolve: async () => { reads.push(Date.now() - NOW); return null; },
    describe: () => ({ protocol: "fixture", relays: [] }),
  };
  return { reads, transport };
}
const perMinute = (reads: number[], from: number, to: number) => reads.filter((at) => at >= from * 60_000 && at < to * 60_000).length / (to - from);

function invite(transport: PkarrTransport, options: Partial<LinkSessionOptions> = {}) {
  const params = createLink().mine;
  const nextIn: number[] = [];
  const link = new LinkSession({ params, transport, pollIntervals: I, invite: true, awaitingSince: NOW - 11 * 60_000,
    events: { onPoll: (p) => { if (!p.polling) nextIn.push(p.nextInMs); } }, ...options });
  return { link, nextIn };
}
function mailbox(transport: PkarrTransport, inviteMadeAt?: number) {
  return new DhtDelivery({ params: createLink().mine, mode: "stream", state: emptyDhtDeliveryState(), credentials: { seedB64: createIdentity().seedB64 }, transport,
    save: async () => {}, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {}, ...(inviteMadeAt !== undefined && { inviteMadeAt }) });
}

describe("an invite nobody used", () => {
  it("15 of them made 11 minutes ago read well under the relays' background share, and less as they age", async () => {
    const { reads, transport } = counting();
    const links = Array.from({ length: 15 }, () => invite(transport).link);
    const boxes = Array.from({ length: 15 }, () => mailbox(transport, NOW - 11 * 60_000));
    for (const link of links) link.start();
    for (const box of boxes) await box.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // Read at the background pace, each key and mailbox twice a minute: 60 reads a minute.
    expect(perMinute(reads, 1, 7)).toBeLessThan(15);
    expect(perMinute(reads, 20, 30)).toBeLessThanOrEqual(10);
    for (const link of links) await link.stop(false);
    for (const box of boxes) await box.stop();
  });

  it("waits a fifth of its age between reads of its key, up to a few minutes, and at the chat's own pace on screen", async () => {
    const { transport } = counting();
    const { link, nextIn } = invite(transport, { awaitingSince: NOW });
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(nextIn.at(-1), "awaited").toBe(I.active);
    vi.setSystemTime(NOW + AWAITING_PEER_MS);
    link.pollNow(); await vi.advanceTimersByTimeAsync(0);
    expect(nextIn.at(-1)).toBe(AWAITING_PEER_MS / 5);
    vi.setSystemTime(NOW + 2 * 3_600_000);
    link.pollNow(); await vi.advanceTimersByTimeAsync(0);
    expect(nextIn.at(-1)).toBe(UNUSED_INVITE_WAIT_MAX_MS);
    // On screen: read at the chat's pace.
    link.setActive(true); await vi.advanceTimersByTimeAsync(0);
    expect(nextIn.at(-1)).toBe(I.idle);
    await link.stop(false);
  });

  it("is not a saved chat: one whose contact is away keeps the background pace", async () => {
    const { transport } = counting();
    const { link, nextIn } = invite(transport, { invite: false, awaitingSince: NOW - 30 * 86_400_000 });
    link.start(); await vi.advanceTimersByTimeAsync(0);
    expect(nextIn.at(-1)).toBe(I.background);
    await link.stop(false);
  });

  it("its mailbox: read at the stream pace while awaited, less often once not, at once when opened; a paired chat's is not slowed", async () => {
    const { reads, transport } = counting();
    const box = mailbox(transport, NOW);
    await box.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads.length, "every 30 s while awaited").toBeGreaterThanOrEqual(20);
    reads.length = 0;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads.length).toBeLessThanOrEqual(5);
    box.setActive(true); await vi.advanceTimersByTimeAsync(0);
    expect(reads.length, "opened: read at once").toBeGreaterThanOrEqual(1);
    await box.stop();
    const saved = counting();
    const chat = new DhtDelivery({ params: createLink().mine, mode: "stream", state: emptyDhtDeliveryState(), credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, transport: saved.transport,
      save: async () => {}, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {}, inviteMadeAt: NOW - 86_400_000 });
    await chat.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(saved.reads.length, "paired: every 30 s").toBeGreaterThanOrEqual(19);
    await chat.stop();
  });
});
