import { describe, expect, it } from "vitest";
import { Groups, JOIN_GIVE_UP_MS, JOIN_KNOCK_WAIT_MAX_MS, joinKnockWait, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { KNOCK_TTL_MS, createIdentity, encodeCommunityLink, encodeGroupEntryLink, toBase64Url, type GhostRecord } from "@ghostly/core";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.link.join, groups.community.join

/**
 * A link whose admin never answers (the link replaced or turned off, the group deleted, the admin's app gone): the
 * joiner's knocks cost the relays less the longer it waits, and one pace is shared by all such joins of an app. After an
 * hour of a run it stops, until Try again, the link opened again or the app's next start.
 */

function memoryStore(): GroupStore {
  const groups = new Map<string, StoredGroup>();
  return {
    getGroups: async () => [...groups.values()].map(g => structuredClone(g)),
    putGroup: async g => { groups.set(g.id, structuredClone(g)); },
    deleteGroup: async id => { groups.delete(id); },
    getMessages: async () => [],
  };
}

/** A joiner alone on the relays: nobody is behind any link it opens. Counts its requests, by key. */
function joiner() {
  const pkarr = new Map<string, GhostRecord[]>();
  const requests: { op: "resolve" | "publish"; key: string; at: number }[] = [];
  let clock = Date.now();
  /** The entry sessions open: id, and the group with the key it is pinned to. */
  const entries = new Map<string, { g: string; peer: string }>();
  const host = {
    sendOnLink: () => { throw new Error("nobody there"); },
    linkReady: () => false,
    linkSeen: () => false,
    contactName: () => undefined,
    edges: () => new Map(),
    openEdge: async () => "edge",
    closeEdge: async (linkId: string) => { entries.delete(linkId); },
    openEntry: async (link: { g: string }, _role: unknown, _seed: unknown, key: string) => { const id = `entry:${link.g}`; entries.set(id, { g: link.g, peer: key }); return id; },
    entries: (g: string) => new Map([...entries].filter(([, e]) => e.g === g).map(([id, e]) => [e.peer, id])),
    publish: async (identity: { pubKeyZ32: string }, records: GhostRecord[]) => { requests.push({ op: "publish", key: identity.pubKeyZ32, at: clock }); pkarr.set(identity.pubKeyZ32, records); },
    resolve: async (key: string) => { requests.push({ op: "resolve", key, at: clock }); return pkarr.get(key) ?? null; },
    edgeNick: () => undefined,
    storeMessage: async () => {},
    emit: () => {},
  } as unknown as GroupsHost;
  const store = memoryStore();
  const groups = new Groups(host, store);
  return {
    groups, requests, entries,
    /** The app starts again: a new engine reads what was stored; the entry sessions stay as the app kept them. */
    async restart() { this.groups = new Groups(host, store); await this.groups.load(); return this.groups; },
    get now() { return clock; },
    /** Ticks the engine every second for `ms`. */
    async run(ms: number) { for (const end = clock + ms; clock < end;) { clock += 1_000; await this.groups.tick(clock); } },
    /** Requests since `at`. */
    since(at: number) { return requests.filter(r => r.at > at).length; },
    /** Requests a minute over the last `ms`. */
    perMinute(ms: number) { return requests.filter(r => r.at > clock - ms).length / (ms / 60_000); },
  };
}

const groupId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
const deadPrivate = () => encodeGroupEntryLink({ g: groupId(), host: createIdentity().pubKeyZ32 });
const deadCommunity = () => encodeCommunityLink({ g: groupId(), host: createIdentity().pubKeyZ32 });

describe("a link join nobody answers", () => {
  it("knocks less often the longer it waits, never past the knock's own life", () => {
    const timings = { knockMs: 5_000, slowKnockMs: 20_000, patienceMs: 2 * 60_000 };
    expect(joinKnockWait(60_000, timings, 1)).toBe(5_000);
    expect(joinKnockWait(3 * 60_000, timings, 4)).toBe(36_000);
    expect(joinKnockWait(60 * 60_000, timings, 4)).toBe(120_000);
    // Alone, it waits no longer than its share of the joins' knocks needs.
    expect(joinKnockWait(60 * 60_000, timings, 1)).toBe(30_000);
    // However many there are, an admin's app that comes back finds each knock fresh.
    expect(joinKnockWait(24 * 60 * 60_000, timings, 50)).toBe(JOIN_KNOCK_WAIT_MAX_MS);
    expect(JOIN_KNOCK_WAIT_MAX_MS).toBeLessThan(KNOCK_TTL_MS);
  });

  it("four dead private-group links take a few of the relays' requests a minute, not 28", async () => {
    const bob = joiner();
    for (let i = 0; i < 4; i++) await bob.groups.joinByLink(deadPrivate());
    await bob.run(20 * 60_000);
    // At `slowKnockMs` for good: 3 knock reads and 1-2 writes a minute each, about 20 in all.
    expect(bob.perMinute(10 * 60_000)).toBeLessThanOrEqual(4.5);
    // Still knocking: each knock is never older than an admin's app would answer.
    const knocks = new Map<string, number[]>();
    for (const r of bob.requests) if (r.op === "publish") knocks.set(r.key, [...knocks.get(r.key) ?? [], r.at]);
    expect(knocks.size).toBe(4);
    for (const times of knocks.values()) for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThan(KNOCK_TTL_MS);
    expect(bob.groups.views().every(v => v.invitation)).toBe(true);
  });

  it("one dead link alone still knocks every half minute", async () => {
    const bob = joiner();
    await bob.groups.joinByLink(deadPrivate());
    await bob.run(20 * 60_000);
    const writes = bob.requests.filter(r => r.op === "publish" && r.at > bob.now - 10 * 60_000).length;
    expect(writes).toBeGreaterThanOrEqual(18);
    expect(bob.perMinute(10 * 60_000)).toBeLessThanOrEqual(4);
  });

  it("a dead community link and dead private ones share one pace", async () => {
    const bob = joiner();
    for (let i = 0; i < 3; i++) await bob.groups.joinByLink(deadPrivate());
    await bob.groups.joinByLink(deadCommunity());
    await bob.run(20 * 60_000);
    expect(bob.perMinute(10 * 60_000)).toBeLessThanOrEqual(4.5);
  });
});

describe("a link join nobody answered for an hour", () => {
  for (const [kind, dead] of [["private group", deadPrivate], ["community", deadCommunity]] as const) {
    it(`stops knocking and reading, says so, and Try again knocks again (${kind})`, async () => {
      const bob = joiner();
      const id = await bob.groups.joinByLink(dead());
      await bob.run(JOIN_GIVE_UP_MS - 60_000);
      expect(bob.groups.views()[0].invitation?.unanswered).toBeUndefined();
      await bob.run(2 * 60_000);
      // Over: no knock, and its entry session is closed (its reads with it), while the row says the link did not answer.
      const over = bob.now;
      expect(bob.groups.views()[0].invitation).toMatchObject({ viaLink: true, unanswered: true });
      expect(bob.entries.size).toBe(0);
      await bob.run(30 * 60_000);
      expect(bob.since(over)).toBe(0);
      // Try again: the entry session is back and a knock goes at once.
      await bob.groups.accept(id);
      await bob.run(1_000);
      expect(bob.groups.views()[0].invitation?.unanswered).toBeUndefined();
      expect(bob.entries.size).toBe(1);
      expect(bob.requests.some(r => r.op === "publish" && r.at >= over + 30 * 60_000)).toBe(true);
    });
  }

  it("opening the link again knocks again", async () => {
    const bob = joiner();
    const code = deadPrivate();
    await bob.groups.joinByLink(code);
    await bob.run(JOIN_GIVE_UP_MS + 60_000);
    expect(bob.groups.views()[0].invitation?.unanswered).toBe(true);
    const at = bob.now;
    await bob.groups.joinByLink(code);
    await bob.run(1_000);
    expect(bob.groups.views()[0].invitation?.unanswered).toBeUndefined();
    expect(bob.requests.some(r => r.op === "publish" && r.at >= at)).toBe(true);
  });

  it("the app's next start knocks again, its entry session opened again", async () => {
    const bob = joiner();
    await bob.groups.joinByLink(deadPrivate());
    await bob.run(JOIN_GIVE_UP_MS + 60_000);
    expect(bob.entries.size).toBe(0);
    const at = bob.now;
    await bob.restart();
    await bob.run(5_000);
    expect(bob.entries.size).toBe(1);
    expect(bob.groups.views()[0].invitation?.unanswered).toBeUndefined();
    expect(bob.since(at)).toBeGreaterThan(0);
  });
});
