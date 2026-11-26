import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { setLinkTraceSink } from "../src/linkTrace";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, useFakeWorld, yieldToLoop, type Opened } from "./support/pairingWorld";

// covers: invite.delivery-mode, transport.chat-switch

/**
 * A contact choosing DHT only on a live chat closes the session, then puts its DHT-only envelope. This side reads the
 * mailbox at once as the session goes (WISP 403, poll pace: "at once when layer 1 is lost"), but that read went before
 * the envelope was there, and the next one was the background read 30 s later: the chooser's first text after the
 * switch took about 30 s to reach a CLI daemon (bug hunt 2026-11-26, 32 s twice, trace: session lost at +92 ms, the
 * envelope at +115 ms, read again at +30.1 s). A session the contact closed is read once more, `DHT_POLL_MS` after.
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

const live = (side: Opened) => side.link.isDataLinkOpen;
const seesDhtOnly = (side: Opened) => side.link.dhtDelivery?.peerMode === "dht";

let reads: { t: number; me: string; step: string }[] = [];
beforeEach(() => { useFakeWorld(); reads = []; setLinkTraceSink(line => reads.push(JSON.parse(line))); });
afterEach(async () => { setLinkTraceSink(null); await closeWorld(); });

describe("a contact that chooses DHT only on a live chat", () => {
  for (const chooser of ["dialler", "answerer"] as const) {
    it(`is seen on DHT only within seconds, not at the next background read · the ${chooser} chooses`, async () => {
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitationWhere("inviter");
      const inviter = open(made.inviter, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS });
      await run(2_000);
      const joiner = open(made.joiner, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS });
      expect(await until(() => live(inviter) && live(joiner), 60_000), "first pairing").toBeLessThan(Infinity);
      const [me, them] = chooser === "dialler" ? [inviter, joiner] : [joiner, inviter];
      // The contact's chat in the background (a daemon's): only its background reads look at the mailbox.
      me.link.setChatActive(true);
      them.link.setChatActive(false);
      // Past the first pairing's fast reads and the relays' minute.
      await run(150_000);
      expect(live(me) && live(them), "still live").toBe(true);
      const chose = me.link.setDeliveryMode("dht");
      const seen = await until(() => seesDhtOnly(them), 40_000);
      await chose;
      expect(seen, "the contact saw DHT only after").toBeLessThan(10_000);
    }, 120_000);
  }
});
