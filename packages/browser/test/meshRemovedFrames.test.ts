import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptText, epochKeys, fromBase64Url, type GroupMessageFrame, type GroupState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredMessage } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.catch-up

/**
 * WISP 400 § Delete for everyone in a private group: what the message said leaves this profile, not only its row. The
 * frames kept to hand on (my own log, `GroupState.sent`, in the group's record and its small row, and a reply's row,
 * `StoredMessage.frame`) are sealed under the epoch's secret, which the same saved state holds: a byte search finds
 * nothing, the secret opens them.
 */
const SECRET = "sk-made-up-group-everyone-0123456789";

/** What each frame opens to with the secrets `state` keeps: its text and the reply it quotes. */
function opened(state: GroupState, frames: GroupMessageFrame[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const secret = state.secrets[f.e];
    if (!secret || !f.c) continue;
    const key = epochKeys(fromBase64Url(secret), f.g, f.e).message;
    out.push(decryptText(key, JSON.stringify([f.g, f.e, f.s, f.n, f.ts]), f.nn, f.c) ?? "");
    if (f.r) out.push(decryptText(key, JSON.stringify(["ghostly-group/1 reply", f.g, f.e, f.s, f.n, f.ts]), f.r.n, f.r.c) ?? "");
  }
  return out;
}

/** What a peer's saved group opens of its own frames: in its record, and in its small row. */
async function saved(peer: Peer, id: string): Promise<{ record: string; live: string }> {
  const record = (await peer.store.getGroups()).find(g => g.id === id)!.state!, live = (await peer.store.getGroupLive!()).get(id)!.state;
  return { record: opened(record, record.sent).join(" "), live: opened(record, live.sent!).join(" ") };
}

describe("a reply to a private group's message deleted for everyone", { timeout: 120_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps no line of it in its author's saved log, the record included; the reply still goes", async () => {
    const world = new CommunityWorld();
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    const [alice, bob, carol] = ["alice", "bob", "carol"].map(name => world.add(name));
    const id = await alice.groups.create("Crew", "mesh");
    const link = await alice.groups.enableLink(id);
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 5 * 60_000);
    await world.run(60_000);
    const sent = await alice.groups.send(id, `the token: ${SECRET}`);
    await world.until(() => world.texts(bob, id).includes(`the token: ${SECRET}`), 60_000);
    await bob.groups.send(id, "got it", [], { i: sent.messageId!, s: `the token: ${SECRET}`, f: sent.messageId!.split(":")[0] });
    await world.until(() => world.texts(alice, id).includes("got it"), 60_000);
    // A commit after it (Carol let in): Bob's record is written whole, its copy of his last frames with it.
    await carol.groups.joinByLink(link);
    await world.until(() => world.member(carol, id), 5 * 60_000);
    await bob.groups.flush();
    expect(await saved(bob, id)).toEqual({ record: expect.stringContaining(SECRET), live: expect.stringContaining(SECRET) });

    // What Bob's engine does as Alice's removal comes (`forgetGroupMessage`): noted, then its row goes.
    await bob.groups.removed(id, sent.messageId!);
    bob.messages.splice(bob.messages.findIndex(m => m.id === sent.messageId), 1);
    await bob.groups.flush();
    expect(await saved(bob, id)).toEqual({ record: expect.not.stringContaining(SECRET), live: expect.not.stringContaining(SECRET) });
    // His reply stays his, still a reply, to hand on.
    expect((await saved(bob, id)).live).toContain(`"i":"${sent.messageId}","s":""`);
    await world.run(5_000);
    await bob.groups.send(id, "after the delete");
    await world.until(() => world.texts(alice, id).includes("after the delete"), 60_000);
  });
});

describe("a reply that quotes a message deleted for everyone", () => {
  it("loses the frame it came in, whose sealed reply holds the quote", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport: { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) }, automaticWallets: false });
    const chat = `group:${crypto.randomUUID()}`;
    const original: StoredMessage = { linkId: chat, id: "a:1:0", text: `the token: ${SECRET}`, sender: "me", timestamp: 1, via: "group" } as StoredMessage;
    const frame = { t: "group-msg", g: "g", e: 1, s: "b", n: 0, ts: 2, nn: "n", c: "c", sig: "s", r: { n: "n", c: "sealed quote" } };
    await db.putMessage({ linkId: chat, id: "b:1:0", text: "got it", sender: "peer", timestamp: 2, via: "group", replyTo: { id: "a:1:0", messageId: "a:1:0", snippet: `the token: ${SECRET}`, from: "me" }, frame } as unknown as StoredMessage);
    await db.putMessage({ linkId: chat, id: "c:1:0", text: "unrelated", sender: "peer", timestamp: 3, via: "group", frame: { ...frame, s: "c" } } as unknown as StoredMessage);
    await node.forgetQuotesOf(original);
    const reply = await db.getMessage(chat, "b:1:0");
    expect(reply?.replyTo?.snippet).toBe("");
    expect(reply?.frame).toBeUndefined();
    // A row that quotes nothing deleted keeps its frame, to hand on.
    expect((await db.getMessage(chat, "c:1:0"))?.frame).toBeTruthy();
  });
});
