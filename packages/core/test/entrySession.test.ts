import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityFromSeedB64 } from "../src/identity";
import { closeWorld, DESKTOP_NETWORK, invitation, MemoryPkarr, open, run, useFakeWorld, type Side } from "./support/pairingWorld";

// covers: groups.community.join, groups.link.join

/**
 * A group's entry session carries one admission and closes; it runs on the member's app while that
 * app is the group's door, whose relay budget (30 requests a minute a relay) also pays for the hub's
 * polling and the next joiner's admission. What it publishes beyond the admission itself is what
 * starved the next joiner's edge in e2e/web/group-community-join.spec.ts: a packet with its presence
 * before the one with its offer, one clearing the offer once connected, and, when the joiner closed its
 * side on the welcome, a dial of the joiner again (an offer, then a packet clearing it).
 */

beforeEach(useFakeWorld);
afterEach(closeWorld);

const keyOf = (side: Side) => identityFromSeedB64(side.params.seedB64).pubKeyZ32;

/** An entry session's two sides, `host` (the member's app) the one that dials, as `dialedKey` draws the joiner's key. */
function entry(): { host: Side; guest: Side } {
  for (;;) {
    const { inviter, joiner } = invitation();
    // Old sides: no pairing progress (an entry session has none), so the lower link key dials.
    const [a, b] = [{ ...inviter, old: true }, { ...joiner, old: true }];
    if (keyOf(a) < keyOf(b)) return { host: a, guest: b };
  }
}

describe("a group's entry session spends the member's relay budget on the admission only", () => {
  it("the member's side offers in its first packet, clears nothing once connected, and does not dial the joiner again once it left", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const { host, guest } = entry();
    const joiner = open(guest, pkarr, { link: { oneShot: true, firstPublish: "at-start" } });
    joiner.link.expectPeer();
    await run(2_000);
    let dials = 0, opened = false;
    const stop = { link: null as null | (() => void) };
    const member = open(host, pkarr, {
      link: { oneShot: true, firstPublish: "after-first-poll" },
      // The engine closes an entry session whose admission is done as soon as its data link does (node.ts).
      onDataLinkState: state => { if (state === "offering") dials++; if (state === "idle" && opened) stop.link?.(); },
    });
    stop.link = () => void member.link.stop(false);
    member.link.expectPeer();
    for (let t = 0; t < 15_000 && !(member.link.isDataLinkOpen && joiner.link.isDataLinkOpen); t += 50) await run(50);
    expect(member.link.isDataLinkOpen && joiner.link.isDataLinkOpen).toBe(true);
    opened = true;
    await run(2_000);
    // One packet from the member's side: its offer (with its presence). None to clear it.
    expect(pkarr.publishesByKey.get(keyOf(host))).toBe(1);
    expect(dials).toBe(1);

    // The joiner got its welcome and closes its side, without a last packet.
    await joiner.link.stop(false);
    await run(30_000);
    expect(pkarr.publishesByKey.get(keyOf(host))).toBe(1);
    expect(dials).toBe(1);
  });

  it("the member's side still says it is here after its first look when the joiner is not (yet)", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const { host } = entry();
    const member = open(host, pkarr, { link: { oneShot: true, firstPublish: "after-first-poll" } });
    member.link.expectPeer();
    await run(3_000);
    expect(pkarr.publishesByKey.get(keyOf(host))).toBe(1);
  });
});
