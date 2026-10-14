import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "../src/bytes";
import { encrypt } from "../src/crypto";
import { identityFromSeed, identityFromSeedB64 } from "../src/identity";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, open, useFakeWorld, yieldToLoop, type Opened, type Side } from "./support/pairingWorld";

// covers: chat.one-chat, chat.dht.fallback, core.peer-keys

/**
 * "Someone else joined with this invite first" (WISP 801) is read from a packet any copy of the invite can write. A
 * chat that was live once is proven the pair the invite made: it never says it, and never refuses a text for it.
 */

const id = () => toBase64Url(randomBytes(16)).slice(0, 22);
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > limit) return Infinity; await run(250); }
  return Date.now() - start;
}
async function stop(side: Opened): Promise<void> {
  let done = false;
  void side.link.stop(false).finally(() => { done = true; });
  await until(() => done, 30_000);
}
async function say(from: Opened, to: Opened, text: string): Promise<void> {
  let sent: string | null | undefined;
  void from.link.sendMessage(text, Date.now(), id()).then(result => { sent = result; });
  expect(await until(() => sent !== undefined, 30_000)).toBeLessThan(Infinity);
  expect(sent).toBeNull();
  expect(await until(() => to.received.some(m => m.text === text), 60_000)).toBeLessThan(Infinity);
}
async function livePair(pkarr: MemoryPkarr, made: { inviter: Side; joiner: Side }): Promise<{ inviter: Opened; joiner: Opened }> {
  const inviter = open(made.inviter, pkarr, { dht: true });
  await run(2_000);
  const joiner = open(made.joiner, pkarr, { dht: true });
  expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 60_000)).toBeLessThan(Infinity);
  await say(joiner, inviter, "hello, live");
  await say(inviter, joiner, "hello back");
  await run(20_000);
  return { inviter, joiner };
}
/**
 * What a copy of the invite can put in the mailbox of the side that went away, from the invite alone and that side's
 * participation key (in the code for the inviter, in the joiner's own hint for the joiner): a packet whose hint names
 * that key and whose envelope opens for nobody.
 */
function sealedToNobody(pkarr: MemoryPkarr, made: { joiner: Side }, away: "inviter" | "joiner", participationKey: string): void {
  const invite = made.joiner.params;
  const joinerKey = identityFromSeedB64(invite.seedB64).pubKeyZ32, inviterKey = invite.peerPubKeyZ32;
  const context = JSON.stringify(["ghostly-dht-delivery/1", [joinerKey, inviterKey].sort()]);
  const derive = (label: string) => hkdf(sha256, fromBase64Url(invite.encKeyB64), utf8Encode(context), utf8Encode(label), 32);
  const mailbox = identityFromSeed(derive(`mailbox:${away === "inviter" ? inviterKey : joinerKey}`));
  // Not awaited: the publication takes fake time.
  void pkarr.transport().publish(mailbox, [{ label: "_dm", value: encrypt("x".repeat(300), randomBytes(32)), ttl: 300 },
    { label: "_dmk", value: encrypt(participationKey, derive("envelope")), ttl: 300 }]);
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a chat that was live, and a copy of its invite writing in the invite's mailbox", () => {
  for (const away of ["inviter", "joiner"] as const) {
    it(`the ${away} away: the other side is not told the invite was taken, and its texts wait`, async () => {
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
      const pair = await livePair(pkarr, made);
      const gone = pair[away], here = pair[away === "inviter" ? "joiner" : "inviter"];
      await stop(gone);
      expect(await until(() => !here.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
      expect(here.dhtState.wasLive, "kept with the chat").toBe(true);

      sealedToNobody(pkarr, made, away, identityFromSeedB64(gone.credentials.seedB64).pubKeyZ32);
      expect(await until(() => !!here.dhtView?.inviteTaken, 3 * 60_000), "never said").toBe(Infinity);
      expect(here.dhtState.inviteTaken).toBeUndefined();
      expect(here.link.validateText("for when you are back", Date.now(), id()), "a text waits for the contact").toBeNull();

      // The same after a restart of the app, from what it stored.
      await stop(here);
      const again = open(made[away === "inviter" ? "joiner" : "inviter"], pkarr, { dht: true, credentials: here.credentials, dhtState: here.dhtState });
      sealedToNobody(pkarr, made, away, identityFromSeedB64(gone.credentials.seedB64).pubKeyZ32);
      expect(await until(() => !!again.dhtView?.inviteTaken, 3 * 60_000), "never said").toBe(Infinity);
      expect(again.link.validateText("still waiting", Date.now(), id())).toBeNull();
    }, 240_000);
  }

  it("a chat that stored the notice drops it the moment it is live again", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const { inviter, joiner } = await livePair(pkarr, made);
    await stop(joiner);
    // As an app from before stored it: the notice, and nothing saying the chat was live.
    const { wasLive: _wasLive, ...stored } = joiner.dhtState;
    const back = open(made.joiner, pkarr, { dht: true, credentials: joiner.credentials, dhtState: { ...stored, inviteTaken: true } });
    expect(await until(() => back.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(1_000);
    expect(back.dhtState.inviteTaken).toBeUndefined();
    expect(back.dhtState.wasLive).toBe(true);
    expect(back.dhtView?.inviteTaken).toBeFalsy();
    await stop(inviter);
    expect(await until(() => !back.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    expect(back.link.validateText("later", Date.now(), id())).toBeNull();
  }, 240_000);
});
