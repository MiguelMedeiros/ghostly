import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { setLinkTraceSink } from "../src/linkTrace";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, useFakeWorld, yieldToLoop, type Opened } from "./support/pairingWorld";

// covers: invite.delivery-mode, transport.chat-switch, chat.paired.reconnect

/**
 * DHT only and back from the chat's Connection menu, on a chat that did its first pairing a moment before, in one
 * process: two browsers' links from a fresh invite (relay pacing), WebRTC stood in for, fake time. The menu leaves DHT
 * only (`setDeliveryMode("stream")`) and applies the transport picked (`setTransportPreference`) right after, which
 * once cancelled the dial the first had just started and left the next one 40 s away. A link also kept the first
 * pairing's 15 s offer for its whole life: an offer made while the contact reads at the background pace (30 s) was
 * withdrawn before it was read, and the next one went 40 s later. The e2e (transport-timeline.spec.ts) took 48 s, or
 * never came back. When the contact's next read falls depends on how long the chat stayed on the DHT: `phase` walks
 * through one background read (measured 2026-09-25: 43-45 s at 5, 10 and 15 s before the fix, 18-28 s after).
 */

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(250);
  }
  return Date.now() - start;
}
/** Awaits what the engine awaits, while time runs (a publish takes fake time). */
async function settle(work: Promise<unknown>): Promise<void> {
  let done = false;
  void work.finally(() => { done = true; });
  await until(() => done, 30_000);
  await work;
}

const live = (side: Opened) => side.link.isDataLinkOpen;
const onDhtOnly = (side: Opened) => !side.link.isDataLinkOpen && side.link.textDelivery === "dht";

let trace: { t: number; me: string; step: string; failures?: number; left?: number }[] = [];
beforeEach(() => { useFakeWorld(); trace = []; setLinkTraceSink(line => trace.push(JSON.parse(line))); });
afterEach(async () => { setLinkTraceSink(null); await closeWorld(); });

describe("DHT only and back from the Connection menu, after a first pairing", () => {
  for (const chooser of ["dialler", "answerer"] as const) for (const contact of ["open", "in the background"] as const) for (const phase of [0, 5_000, 10_000, 15_000, 20_000, 25_000]) {
    it(`is live again at the contact's next read · the ${chooser} chooses · the contact's chat ${contact} · ${90 + phase / 1000} s on the DHT`, async () => {
      // The lower link key dials once the first pairing is over; the inviter holds the one of the pair that dials here.
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitationWhere("inviter");
      const inviter = open(made.inviter, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS });
      await run(2_000);
      const joiner = open(made.joiner, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS });
      expect(await until(() => live(inviter) && live(joiner), 60_000), "first pairing").toBeLessThan(Infinity);
      expect(inviter.link.pairingProgress?.stage).toBe("live");
      const [me, them] = chooser === "dialler" ? [inviter, joiner] : [joiner, inviter];
      expect(me.link.dialer).toBe(chooser === "dialler" ? "you" : "contact");
      me.link.setChatActive(true);
      them.link.setChatActive(contact === "open");
      await run(10_000);

      await settle(me.link.setDeliveryMode("dht"));
      expect(await until(() => onDhtOnly(me) && onDhtOnly(them), 120_000), "both on DHT only").toBeLessThan(Infinity);
      // A while on the DHT, as in the e2e: the contact's fast reads from the switch are long over.
      await run(90_000 + phase);

      // What the menu does to leave DHT only for WebRTC (node.ts setChatTransport).
      const left = Date.now();
      await settle(me.link.setDeliveryMode("stream"));
      await settle(me.link.setTransportPreference("webrtc/1", true, false, true));
      const took = await until(() => live(me) && live(them), 180_000) === Infinity ? Infinity : Date.now() - left;
      const since = trace.filter(step => step.t >= left);
      expect(since.filter(step => step.step === "dial-backoff" && (step.left ?? 0) >= 20_000), "no redial left 20 s or more away").toEqual([]);
      expect(since.filter(step => step.step === "attempt-timeout"), "no offer given up before it was read").toEqual([]);
      // The contact reads at its chat's pace: 4 s with the chat open, 30 s in the background (RELAY_POLL_INTERVALS).
      expect(took, "live again after leaving DHT only").toBeLessThanOrEqual(contact === "open" ? 15_000 : 35_000);
    }, 120_000);
  }
});
