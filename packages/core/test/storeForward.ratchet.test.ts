import { expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { createLink, type LinkParams } from "../src/invite";
import { fromBase64Url, utf8Decode, utf8Encode } from "../src/bytes";
import { HOLD_LIMITS, HoldKeys, HoldRefusedError, newHoldMailbox } from "../src/storeForward";
import { emptyRatchetState, RatchetBox, type RatchetKeys } from "../src/ratchet";
// covers: delivery.hold.protocol, delivery.hold.legacy-peer, chat.ratchet

/** Alice invited Bob; both pinned each other's participation key, and each has the chat's ratchet. */
function pair() {
  const link = createLink();
  const alice = createIdentity(), bob = createIdentity();
  const keys = (params: LinkParams, seed: string, peer: string): RatchetKeys => ({ seed: fromBase64Url(seed), self: identityFromSeedB64(seed).pubKeyZ32, peer,
    rendezvous: [identityFromSeedB64(params.seedB64).pubKeyZ32, params.peerPubKeyZ32], secret: fromBase64Url(params.encKeyB64) });
  return {
    alice: new HoldKeys(link.mine, alice.seedB64, bob.pubKeyZ32), bob: new HoldKeys(link.invite, bob.seedB64, alice.pubKeyZ32),
    aliceBox: new RatchetBox(() => keys(link.mine, alice.seedB64, bob.pubKeyZ32), emptyRatchetState(), async () => {}),
    bobBox: new RatchetBox(() => keys(link.invite, bob.seedB64, alice.pubKeyZ32), emptyRatchetState(), async () => {}),
  };
}
const item = (mailbox: string, seq: number, kind: "text" | "manifest" = "text") =>
  ({ mailbox, seq, id: `held${String(seq).padStart(18, "0")}`, ts: Date.now(), kind, meta: kind === "manifest" ? { entries: [] } : undefined, expires: Date.now() + HOLD_LIMITS.ttlMs });

it("a ratcheted bundle (version 2) opens in any order, each once, and an app from before refuses it as newer", async () => {
  const { alice, bob, aliceBox, bobBox } = pair();
  const mailbox = newHoldMailbox();
  const bundles = [];
  for (let seq = 1; seq <= 4; seq++) bundles.push(await alice.sealRatcheted(item(mailbox, seq), utf8Encode(`held ${seq}`), plain => aliceBox.lock(tx => tx.seal("hold", plain))));
  for (const b of bundles) { expect(b[4]).toBe(2); expect(new TextDecoder().decode(b)).not.toContain("held "); }
  expect(() => bob.open(bundles[0])).toThrow(/newer Ghostly/);
  for (const i of [3, 0, 2, 1]) {
    const opened = bob.open(bundles[i], { mailbox, ratchet: sealed => bobBox.peek("hold", sealed) });
    expect(utf8Decode(opened.body)).toBe(`held ${i + 1}`);
    expect(opened.ratcheted).toBeDefined();
    expect(await bobBox.commitOpen("hold", opened.ratcheted!)).toBe(true);
  }
  expect(() => bob.open(bundles[1], { ratchet: sealed => bobBox.peek("hold", sealed) })).toThrow(/opened already/);
  expect(bobBox.heard("hold")).toBe(true);
});

it("once ratcheted items come, a plain one is refused; the manifest stays plain and is read", async () => {
  const { alice, bob, bobBox } = pair();
  const mailbox = newHoldMailbox();
  const plain = alice.seal(item(mailbox, 9), utf8Encode("plain"));
  const manifest = alice.seal(item(mailbox, 10, "manifest"), new Uint8Array());
  const refused = (() => { try { bob.open(plain, { refusePlain: true, ratchet: s => bobBox.peek("hold", s) }); } catch (e) { return (e as HoldRefusedError).reason; } })();
  expect(refused).toBe("plain");
  expect(bob.open(manifest, { refusePlain: true, ratchet: s => bobBox.peek("hold", s) }).header.kind).toBe("manifest");
  expect(utf8Decode(bob.open(plain).body)).toBe("plain");
});
