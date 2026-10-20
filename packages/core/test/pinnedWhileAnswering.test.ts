import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, run, useFakeWorld, type Opened } from "./support/pairingWorld";

// covers: chat.one-chat, core.peer-keys

/**
 * Two copies of a fresh invite used at once: the inviter answers one copy's offer, and the other copy's first contact
 * pins its key on the DHT before that WebRTC channel opens. The session began before the pin: like one that opened
 * before it (WISP 400 req. 8), it closes with a passive foreign-key notice, and the chat goes on with the pinned key.
 */

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a pin made while the inviter answers another copy's offer", () => {
  it("closes that session when its channel opens, and stops nothing", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitationWhere("joiner");
    const other = createIdentity().pubKeyZ32;
    let pinnedAt = 0;
    // The DHT's first contact from the other copy pins its key once this side began answering.
    const inviter: Opened = open(made.inviter, pkarr, { dht: true, onDataLinkState: state => {
      if (state === "answering" && !inviter.credentials.peerKey) { inviter.credentials.peerKey = other; pinnedAt = Date.now(); }
    } });
    await run(2_000);
    const joiner = open(made.joiner, pkarr, { dht: true });
    // Answered, pinned, then the channel opens (`CONNECT_MS`) and the joiner's session meets the pinned key.
    await run(30_000);
    expect(pinnedAt, "answered").toBeGreaterThan(0);
    expect(inviter.dhtView?.foreignKeySeenAt, "a passive notice").toBeGreaterThan(0);
    expect(inviter.states.some(state => state.status === "error" || state.keyMismatch), "no key stop").toBe(false);
    expect(inviter.progress.some(p => p.stage === "failed" || p.reason === "key-mismatch"), "the chat goes on").toBe(false);
    expect(inviter.credentials.peerKey).toBe(other);
    expect(identityFromSeedB64(joiner.credentials.seedB64).pubKeyZ32).not.toBe(other);
  });
});
