import { describe, expect, it } from "vitest";
import { createIdentity, encodeGroupEntryLink, entryParams, identityFromSeedB64, randomBytes, toBase64Url, type GroupEntryLink } from "@ghostly/core";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.link.join, groups.protocol.entry

/** A joiner's engine with nothing behind it: what `joinByLink` opens, and under which member key. */
function joiner() {
  const opened: { link: GroupEntryLink; seedB64: string }[] = [];
  const groups = new Map<string, StoredGroup>();
  const host = {
    openEntry: async (link: GroupEntryLink, _role: string, seedB64: string) => { opened.push({ link, seedB64 }); return `entry:${opened.length}`; },
    entries: () => new Map(), edges: () => new Map(), linkReady: () => false,
    publish: async () => {}, resolve: async () => null,
    storeMessage: async () => {}, emit: () => {},
  } as unknown as GroupsHost;
  const store: GroupStore = {
    getGroups: async () => [...groups.values()], putGroup: async g => { groups.set(g.id, g); },
    deleteGroup: async id => { groups.delete(id); }, getMessages: async () => [],
  };
  return { engine: new Groups(host, store), opened };
}

describe("joining a private group through its link", () => {
  it("draws a member key whose entry session the admin's side dials", async () => {
    // Of a paired session's two ends the lower key dials, once it has seen the other. The admin's side opens the entry
    // session on seeing the knock, with the joiner there already: when it is the one that dials, its offer goes in its
    // first packet. With a key drawn at random, half the joins waited one more trip through Pkarr.
    const link: GroupEntryLink = { g: toBase64Url(randomBytes(16)), host: createIdentity().pubKeyZ32 };
    for (let i = 0; i < 12; i++) {
      const { engine, opened } = joiner();
      await engine.load();
      await engine.joinByLink(encodeGroupEntryLink(link));
      expect(opened).toHaveLength(1);
      const me = identityFromSeedB64(opened[0].seedB64), params = entryParams(link, me.seed, me.pubKeyZ32, link.host);
      expect(identityFromSeedB64(params.seedB64).pubKeyZ32 > params.peerPubKeyZ32).toBe(true);
    }
  });
});
