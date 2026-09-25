import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, toBase64Url } from "../src/bytes";
import { createIdentity } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, invitationWhere, open, rtc, useFakeWorld, yieldToLoop, type Opened } from "./support/pairingWorld";

// covers: chat.one-chat, chat.dht.fallback, chat.paired.reconnect, core.peer-keys

/**
 * The one chat of WISP 400, end to end in one process: two links from a fresh invite on an in-memory Pkarr,
 * WebRTC stood in for by peer connections that can be told to never connect, fake time. First contact runs
 * on the DHT and on a stream at once; with every transport blocked the chat opens on the DHT, and when they
 * unblock it goes live by itself, losing and duplicating nothing on the way there and back.
 */

const id = () => toBase64Url(randomBytes(16)).slice(0, 22);
const texts = (side: Opened) => side.received.map(m => m.text);

/** Fake time in steps coarse enough to cover minutes quickly, fine enough for the network model's delays. */
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

/** Stops a link while time runs (what it has in flight takes fake time). */
async function stop(side: Opened): Promise<void> {
  let done = false;
  void side.link.stop(false).finally(() => { done = true; });
  await until(() => done, 30_000);
}

/** Sends a text the way the engine's outbox does: a stable id, and the next one only once this one is confirmed. */
async function say(from: Opened, to: Opened, text: string): Promise<string> {
  const wire = id();
  // The network's delays are fake time too: the send settles while time runs.
  let sent: string | null | undefined;
  void from.link.sendMessage(text, Date.now(), wire).then(result => { sent = result; });
  expect(await until(() => sent !== undefined, 30_000), `${text} is handed over`).toBeLessThan(Infinity);
  expect(sent, `${text} goes`).toBeNull();
  expect(await until(() => from.receipts.includes(wire), 60_000), `${text} is confirmed`).toBeLessThan(Infinity);
  expect(texts(to).filter(t => t === text), `${text} arrives once`).toHaveLength(1);
  return wire;
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("one chat: DHT rendezvous, peer-to-peer upgrade, DHT fallback", () => {
  it("with every transport blocked a first pairing opens on the DHT, chats there, and goes live by itself once one connects", async () => {
    rtc.blocked = true;
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true });
    await run(2_000);
    const joiner = open(made.joiner, pkarr, { dht: true });

    // Pinned over the DHT on both sides, each to the other's participation key; no stream, no failure.
    const pinned = await until(() => !!inviter.credentials.peerKey && !!joiner.credentials.peerKey
      && inviter.link.textDelivery === "dht" && joiner.link.textDelivery === "dht", 60_000);
    expect(pinned, "first contact over the DHT, in seconds").toBeLessThan(20_000);
    expect(inviter.credentials.peerKey).toBe(createIdentityKey(made.joiner.seedB64));
    expect(joiner.credentials.peerKey).toBe(createIdentityKey(made.inviter.seedB64));
    await run(40_000);
    for (const side of [inviter, joiner]) {
      expect(side.link.pairingProgress?.stage, `${side.link.pairingProgress?.role} is on the DHT`).toBe("on-dht");
      expect(side.progress.some(p => p.stage === "failed"), "a stream that did not connect is no failure").toBe(false);
      expect(side.link.isDataLinkOpen).toBe(false);
    }

    // Text goes both ways on the DHT meanwhile.
    await say(joiner, inviter, "hello over the DHT");
    await say(inviter, joiner, "and back");

    // The transports come back: the background retry finds one without anyone doing anything.
    rtc.blocked = false;
    const live = await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 5 * 60_000);
    expect(live, "live again within the background retry's longest wait (3 min)").toBeLessThanOrEqual(3 * 60_000 + 30_000);
    for (const side of [inviter, joiner]) expect(side.link.pairingProgress?.stage).toBe("live");
    await say(inviter, joiner, "now live");
    expect(joiner.received.find(m => m.text === "now live")?.via).toBe("datalink");

    // Nothing was lost or shown twice across the move.
    expect(texts(joiner)).toEqual(["and back", "now live"]);
    expect(texts(inviter)).toEqual(["hello over the DHT"]);
  }, 120_000);

  it("dials a native transport the contact's record just named at once, not after the wait failed attempts built up", async () => {
    // No WebRTC between them (Linux Desktop): until the record arrives there is nothing to dial, and every attempt
    // with nothing to try doubles the wait before the next one, up to three minutes.
    rtc.blocked = true;
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitationWhere("inviter");
    const inviter = open(made.inviter, pkarr, { dht: true });
    await run(2_000);
    open(made.joiner, pkarr, { dht: true });
    expect(await until(() => inviter.link.pairingProgress?.stage === "on-dht", 60_000)).toBeLessThan(Infinity);
    await run(90_000);
    const calls: string[] = [];
    inviter.link.registerEndpoint({ transport: "iroh/1", descriptor: { id: "mine" }, onConnection: null, onDescriptor: null,
      connect: async () => { calls.push("iroh/1"); throw new Error("no answer"); }, close: async () => {} });
    inviter.link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "theirs" } });
    await run(2_000);
    expect(calls, "the side that dials tries the record's transport now").toEqual(["iroh/1"]);
  }, 120_000);

  it("announces a new capability-record revision in an envelope only on the DHT, never on a live chat", async () => {
    const announced = (side: Opened) => vi.spyOn((side.link as unknown as { dht: { announce(): Promise<void> } }).dht, "announce");
    // Live: the session says it all, and the relays' budget is for signalling and held items.
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true });
    await run(2_000);
    const joiner = open(made.joiner, pkarr, { dht: true });
    expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 60_000)).toBeLessThan(Infinity);
    const live = announced(inviter);
    inviter.link.announceCapsRevision();
    expect(live).not.toHaveBeenCalled();
    await stop(inviter); await stop(joiner);

    // On the DHT, pinned: an envelope is the only way the contact hears of it.
    rtc.blocked = true;
    const other = invitation();
    const a = open(other.inviter, pkarr, { dht: true });
    await run(2_000);
    open(other.joiner, pkarr, { dht: true });
    expect(await until(() => a.link.pairingProgress?.stage === "on-dht" && !!a.credentials.peerKey, 60_000)).toBeLessThan(Infinity);
    const onDht = announced(a);
    a.link.announceCapsRevision();
    expect(onDht).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("live, then a drop: back on the DHT at once, text still goes, and live again when the contact is back", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true });
    await run(2_000);
    let joiner = open(made.joiner, pkarr, { dht: true });
    expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 60_000)).toBeLessThan(Infinity);
    expect(inviter.link.pairingProgress?.stage).toBe("live");
    await say(joiner, inviter, "live first");
    // The contact's side reads the mailbox every 5 minutes while live, not every 30 s.
    const readsLive = pkarr.reads;
    await run(60_000);
    expect(pkarr.reads - readsLive, "two live links read little in a minute").toBeLessThan(30);

    // The joiner's app goes away without a word, and comes back from what it saved, with transports blocked.
    const saved = { credentials: { ...joiner.credentials }, dhtState: joiner.dhtState };
    await stop(joiner);
    rtc.blocked = true;
    await run(1_000);
    joiner = open(made.joiner, pkarr, { dht: true, credentials: saved.credentials, dhtState: saved.dhtState });
    expect(await until(() => !inviter.link.isDataLinkOpen, 90_000), "the dead session is noticed (3 missed pings)").toBeLessThan(Infinity);
    expect(await until(() => inviter.link.textDelivery === "dht" && joiner.link.textDelivery === "dht", 60_000)).toBeLessThan(Infinity);
    await say(inviter, joiner, "while it was away");
    rtc.blocked = false;
    expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 5 * 60_000)).toBeLessThan(Infinity);
    await say(joiner, inviter, "live again");
    expect(texts(inviter)).toEqual(["live first", "live again"]);
    expect(texts(joiner)).toEqual(["while it was away"]);
  }, 120_000);
});

describe("one chat: first contact on two paths, one key", () => {
  it("a copied invite that pins first over the DHT stops the chat on both layers when the real joiner's key shows", async () => {
    rtc.blocked = true;
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true });
    await run(2_000);
    // Someone holding a copy of the invite answers first, with a key of its own.
    const copy = open({ ...made.joiner, seedB64: createIdentity().seedB64 }, pkarr, { dht: true });
    expect(await until(() => !!inviter.credentials.peerKey, 60_000)).toBeLessThan(Infinity);
    const first = inviter.credentials.peerKey;
    await stop(copy);
    // The joiner the invite was for: its first contact carries another key, on the DHT and on the stream.
    rtc.blocked = false;
    open(made.joiner, pkarr, { dht: true });
    expect(await until(() => inviter.states.some(s => s.keyMismatch), 90_000), "a security rejection, not a fallback").toBeLessThan(Infinity);
    await run(60_000);
    expect(inviter.credentials.peerKey, "the pin is not replaced").toBe(first);
    expect(inviter.link.isDataLinkOpen, "no stream either").toBe(false);
    expect(inviter.link.textDelivery).toBe("unavailable");
    expect(inviter.link.pairingProgress).toMatchObject({ stage: "failed", reason: "key-mismatch", retryable: false });
  }, 120_000);

  it("a stream pinned first, then a first-contact envelope signed by another key: the live session stops too", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true });
    await run(2_000);
    const joiner = open(made.joiner, pkarr, { dht: true });
    expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 60_000)).toBeLessThan(Infinity);
    // A copy of the invite publishes in the joiner's mailbox, signed by a key of its own.
    const copy = open({ ...made.joiner, seedB64: createIdentity().seedB64 }, pkarr, { dht: true, credentials: { seedB64: createIdentity().seedB64 } });
    await stop(joiner);
    expect(await until(() => inviter.states.some(s => s.keyMismatch), 5 * 60_000 + 30_000)).toBeLessThan(Infinity);
    await stop(copy);
    expect(inviter.link.isDataLinkOpen).toBe(false);
    expect(inviter.link.textDelivery).toBe("unavailable");
  }, 120_000);
});

function createIdentityKey(seedB64: string): string {
  // The participation key each side pins is the other's public key from its participation seed.
  return identityFromSeedB64(seedB64).pubKeyZ32;
}
import { identityFromSeedB64 } from "../src/identity";

describe("one chat: what the DHT floor costs the relays", () => {
  /**
   * The relays allow a browser 30 requests a minute per relay, reads and publishes together (relay.ts), shared by
   * every chat. The floor must stay a small part of it: a live chat reads its mailbox every 5 minutes, a chat on
   * the DHT in the background every 30 s. Presence polling and redial offers (the link's own key) are counted
   * apart: they are the transport's, and the same with or without the floor.
   */
  it("a live chat and a chat on the DHT stay well inside the relays' budget", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    await run(2_000);
    const joiner = open(made.joiner, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    expect(await until(() => inviter.link.isDataLinkOpen && joiner.link.isDataLinkOpen, 90_000)).toBeLessThan(Infinity);
    await run(60_000);
    const linkKeys = new Set([inviter.link.myPubKeyZ32, joiner.link.myPubKeyZ32]);
    /** Reads a minute, both sides together, of the floor's records (mailboxes, capability records), over `ms`. */
    const floorReads = async (ms: number) => {
      const before = new Map(pkarr.readsByKey);
      await run(ms);
      const reads = [...pkarr.readsByKey].filter(([key]) => !linkKeys.has(key)).reduce((sum, [key, n]) => sum + n - (before.get(key) ?? 0), 0);
      return reads / (ms / 60_000);
    };
    const live = await floorReads(10 * 60_000);
    rtc.blocked = true;
    await stop(joiner);
    const dropped = await floorReads(5 * 60_000);
    // Measured 2026-09-25: live 0.4/min, on the DHT 1.8/min (both sides together). The budget is 60/min (two relays).
    expect(live, "live: every 5 minutes").toBeLessThanOrEqual(1);
    expect(dropped, "on the DHT, in the background: every 30 s").toBeLessThanOrEqual(3);
  }, 180_000);
});
