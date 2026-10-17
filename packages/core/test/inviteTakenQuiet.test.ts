import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, randomBytes, utf8Encode } from "../src/bytes";
import { encrypt } from "../src/crypto";
import { createIdentity, identityFromSeed, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, open, useFakeWorld, yieldToLoop } from "./support/pairingWorld";

// covers: chat.one-chat, core.peer-keys

/**
 * A joiner told the invite was taken (someone else used it first) holds the same link key as the one who joined: its
 * packets there read as that contact's. It went on publishing on it every 4 minutes, so once the real joiner quit for
 * good, the inviter showed it online for good and dialled its dead endpoint (bug hunt 1016-2110).
 */

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > limit) return Infinity; await run(250); }
  return Date.now() - start;
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a joiner whose invite someone else used first", () => {
  it("stops publishing on the shared joiner key, so a joiner who quit shows offline", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    await run(2_000);
    const first = open({ ...made.joiner, seedB64: createIdentity().seedB64 }, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    expect(await until(() => inviter.link.isDataLinkOpen && first.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);

    // The second joiner writes through a transport of its own: its publishes, apart from the pair's.
    let publishes = 0;
    const counted = Object.assign(Object.create(pkarr) as MemoryPkarr, { transport: () => {
      const transport = pkarr.transport();
      return { ...transport, publish: (...args: Parameters<typeof transport.publish>) => { publishes++; return transport.publish(...args); } };
    } });
    const second = open(made.joiner, counted, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, credentials: { seedB64: made.joiner.seedB64, expectedPeerKey: identityFromSeedB64(made.inviter.seedB64).pubKeyZ32 } });
    expect(await until(() => !!second.dhtView?.inviteTaken, 60_000)).toBeLessThan(Infinity);
    await run(10_000);

    // The joiner who paired quits for good.
    const after = publishes;
    // Its goodbye takes fake time to go out.
    const stopping = first.link.stop(true);
    await run(8 * 60_000);
    await stopping;
    expect(second.link.pairingProgress?.reason, "still taken").toBe("taken");
    expect(publishes - after, "the taken chat writes nothing in 8 minutes").toBe(0);
    expect(inviter.link.presence.online, "the joiner who quit is offline").toBe(false);
  }, 240_000);

  it("speaks again, and goes live, once the invite turns out not taken", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    // A copy of the invite says, in the inviter's mailbox, that the inviter sealed its envelope to someone else.
    const invite = made.joiner.params, inviterKey = identityFromSeedB64(made.inviter.seedB64).pubKeyZ32;
    const linkKeys = [identityFromSeedB64(invite.seedB64).pubKeyZ32, invite.peerPubKeyZ32];
    const context = JSON.stringify(["ghostly-dht-delivery/1", [...linkKeys].sort()]);
    const derive = (label: string) => hkdf(sha256, fromBase64Url(invite.encKeyB64), utf8Encode(context), utf8Encode(label), 32);
    void pkarr.transport().publish(identityFromSeed(derive(`mailbox:${invite.peerPubKeyZ32}`)), [{ label: "_dm", value: encrypt("x".repeat(300), randomBytes(32)), ttl: 300 },
      { label: "_dmk", value: encrypt(inviterKey, derive("envelope")), ttl: 300 }]);
    await run(2_000);

    const joiner = open(made.joiner, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    expect(await until(() => !!joiner.dhtView?.inviteTaken, 60_000)).toBeLessThan(Infinity);
    await run(10_000);
    const joinerKey = linkKeys[0], quiet = pkarr.publishesByKey.get(joinerKey) ?? 0;
    await run(5 * 60_000);
    expect(pkarr.publishesByKey.get(joinerKey) ?? 0, "nothing on the joiner's link key while taken").toBe(quiet);

    // The inviter comes: its envelope opens here, and the chat pairs after all.
    const inviter = open(made.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 30 * 60_000), "live").toBeLessThan(Infinity);
    expect(joiner.dhtView?.inviteTaken).toBeFalsy();
  }, 240_000);
});
