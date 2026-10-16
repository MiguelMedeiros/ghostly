import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contactDay, createChatInvite, createIdentity, knockSlotIdentity, knockSlotOf, knockSlotRecords, makeStamp, readContactLink, readLinkRecord, requestRecords,
  seenEntry, REQUEST_LIFETIME_MS, type GhostRecord,
} from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { CONTACT_LINKS_KEY, ContactLinks, POLL_MS, POLL_SHOWN_MS, SHOWN_FOR_MS, type ContactLinkHost } from "../src/engine/contactLinks";

vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password)),
  };
});

const NOW = Date.UTC(2026, 9, 16, 12);
/** The lowest difficulty a link record may say, so the tests make stamps quickly; the rules do not depend on it. */
const BITS = 16;

/** An owner on an in-memory Pkarr that requesters write to with the core's own records. */
function world() {
  const pkarr = new Map<string, GhostRecord[]>();
  const state = { reads: 0, own: new Set<string>() };
  const host: ContactLinkHost = {
    online: () => true,
    emit: () => {},
    publish: async (identity, records) => { pkarr.set(identity.pubKeyZ32, records); },
    resolve: async key => { state.reads++; return pkarr.get(key) ?? null; },
    ownInvite: code => state.own.has(code),
  };
  const links = new ContactLinks(host);
  /** A requester asks through the link: its request under its asker key, its knock in its slot. */
  const ask = (linkKey: string, over: { name?: string; text?: string; invite?: string; expires?: number; sealedFor?: string } = {}) => {
    const asker = createIdentity();
    const invite = over.invite ?? createChatInvite().inviteCode;
    pkarr.set(asker.pubKeyZ32, requestRecords(asker.seedB64, over.sealedFor ?? linkKey, {
      invite, name: over.name ?? "Kevin", text: over.text ?? "Hello from your site", issued: Date.now(), expires: over.expires ?? Date.now() + REQUEST_LIFETIME_MS,
    }));
    const slot = knockSlotIdentity(linkKey, knockSlotOf(linkKey, asker.pubKeyZ32)).pubKeyZ32;
    const day = contactDay(Date.now());
    const knocks = [{ key: asker.pubKeyZ32, day, stamp: makeStamp(linkKey, asker.pubKeyZ32, day, BITS) }];
    pkarr.set(slot, knockSlotRecords(linkKey, knocks));
    return { asker, invite };
  };
  return { pkarr, state, links, ask };
}

/** Makes the profile's link and lowers its stamp's difficulty, as a link's stored state. */
async function linkOf(w: ReturnType<typeof world>): Promise<string> {
  await w.links.load();
  const { code } = await w.links.create();
  const record = await wrap<{ current: { inbox: { bits: number } } }>((await store(STORES.settings, "readonly")).get(CONTACT_LINKS_KEY));
  record.current.inbox.bits = BITS;
  await wrap((await store(STORES.settings, "readwrite")).put(record, CONTACT_LINKS_KEY));
  await w.links.load();
  const read = readContactLink(code);
  if (!read.ok) throw new Error(read.reason);
  return read.linkKeyZ32;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  await transact([STORES.settings], stores => { stores[STORES.settings].delete(CONTACT_LINKS_KEY); });
});
afterEach(() => { vi.useRealTimers(); });

describe("a contact link's requests, the owner's side (WISP 8xx)", () => {
  it("a request that knocked goes in Requests, and the link record says it arrived", async () => {
    const w = world();
    const linkKey = await linkOf(w);
    const { asker } = w.ask(linkKey, { name: "Kevin", text: "Hi! Saw your site." });
    await w.links.poll();
    expect(w.links.requests()).toEqual([{ id: asker.pubKeyZ32, name: "Kevin", text: "Hi! Saw your site.", receivedAt: NOW, expires: NOW + REQUEST_LIFETIME_MS }]);
    expect(w.links.view()).toMatchObject({ waiting: 1, missed: 0, state: "open" });
    expect(readLinkRecord(w.pkarr.get(linkKey)!)?.seen).toEqual([seenEntry(linkKey, asker.pubKeyZ32)]);
    // Read once: a second look at the same knock reads no request again.
    const reads = w.state.reads;
    await w.links.poll();
    expect(w.state.reads - reads).toBe(4);
    expect(w.links.requests()).toHaveLength(1);
  });

  it("takes nothing that does not open for this link, and does not read that key again within the hour", async () => {
    const w = world();
    const linkKey = await linkOf(w);
    const other = await (async () => { const v = world(); return linkOf(v); })();
    w.ask(linkKey, { sealedFor: other });
    await w.links.poll();
    expect(w.links.requests()).toEqual([]);
    const reads = w.state.reads;
    await w.links.poll();
    expect(w.state.reads - reads).toBe(4);
  });

  it("takes no request that carries one of the owner's own invites", async () => {
    const w = world();
    const linkKey = await linkOf(w);
    const invite = createChatInvite().inviteCode;
    w.state.own.add(invite);
    w.ask(linkKey, { invite });
    await w.links.poll();
    expect(w.links.requests()).toEqual([]);
  });

  it("a request that waited past its time leaves Requests", async () => {
    const w = world();
    const linkKey = await linkOf(w);
    w.ask(linkKey, { expires: NOW + 60_000 });
    await w.links.poll();
    expect(w.links.requests()).toHaveLength(1);
    vi.setSystemTime(NOW + 60_000);
    await w.links.poll();
    expect(w.links.requests()).toEqual([]);
    expect(w.links.view()?.waiting).toBe(0);
  });

  it("reads every five minutes, and every 15 s for ten minutes once the link was shown", async () => {
    const w = world();
    await linkOf(w);
    w.links.start();
    await vi.advanceTimersByTimeAsync(15_000);
    const first = w.state.reads;
    expect(first).toBe(4);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(w.state.reads).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.state.reads).toBe(first + 4);
    w.links.shown();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.state.reads).toBe(first + 8);
    await vi.advanceTimersByTimeAsync(POLL_SHOWN_MS);
    expect(w.state.reads).toBe(first + 12);
    await vi.advanceTimersByTimeAsync(SHOWN_FOR_MS);
    const settled = w.state.reads;
    await vi.advanceTimersByTimeAsync(POLL_SHOWN_MS * 2);
    expect(w.state.reads).toBe(settled);
    w.links.stop();
  });
});
