import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredMessage } from "../src/shared/types";

// covers: groups.catch-up, groups.protocol.mentions

/*
 * A private group's message first stored from a copy another member handed on without its author's whole signature
 * (WISP 9xx · Group Mesh § Catch-up): the whole copy, when it comes, adds what the first lacked to the stored row.
 */

beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { for (const name of [STORES.settings, STORES.links, STORES.messages]) s[name].clear(); });
});

function engine(): GhostlyNode {
  return new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { automaticWallets: false });
}

describe("a group message completed by its whole copy", () => {
  const author = createIdentity().pubKeyZ32, me = createIdentity().pubKeyZ32;
  const base: StoredMessage = { linkId: "group:g1", id: `${author}:0:3`, text: "@Bo look", sender: "peer", member: author, timestamp: 1_000, via: "datalink" };

  it("takes the mentions, reply and hop count of the whole copy, and keeps the text and time", async () => {
    const node = engine();
    await node["storeMessage"](base);
    const [first] = await db.getMessages("group:g1");
    await node["completeGroupMessage"]({ ...base, text: "ignored", timestamp: 9_999, mentions: [{ k: me, o: 0, l: 3 }], mentioned: true, forwarded: 2,
      replyTo: { id: `${author}:0:1`, snippet: "earlier", member: author } });
    const [stored] = await db.getMessages("group:g1");
    // Its place (when the first copy came) and the time its author said stay as they were.
    expect(stored).toMatchObject({ text: "@Bo look", timestamp: first.timestamp, sentAt: 1_000, mentions: [{ k: me, o: 0, l: 3 }], mentioned: true, forwarded: 2 });
    expect(stored.replyTo?.id).toBe(`${author}:0:1`);
  });

  it("stores it when the first copy never was, and leaves another member's row alone", async () => {
    const node = engine();
    await node["completeGroupMessage"]({ ...base, mentions: [{ k: me, o: 0, l: 3 }] });
    expect((await db.getMessages("group:g1"))[0].mentions).toEqual([{ k: me, o: 0, l: 3 }]);
    const other = createIdentity().pubKeyZ32;
    await node["storeMessage"]({ ...base, id: "x:0:0", member: other });
    await node["completeGroupMessage"]({ ...base, id: "x:0:0", mentions: [{ k: me, o: 0, l: 3 }] });
    expect((await db.getMessages("group:g1")).find(m => m.id === "x:0:0")!.mentions).toBeUndefined();
  });
});
