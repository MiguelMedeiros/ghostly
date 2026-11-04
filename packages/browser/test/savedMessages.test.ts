import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { GhostlyNode } from "../src/engine/node";
import { SAVED_MESSAGES_KEY } from "../src/engine/saved";
import { PROFILE_SETTINGS_KEYS, STORES, store, wrap } from "../src/shared/idb";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.saved

/**
 * Saved messages: a mark the person puts on a message of any chat or group, kept for the profile on this device and
 * never sent. The list reads each mark with its row, so an edit shows its latest text and a deleted message, chat or
 * group drops out.
 */

let n = 0;
const message = (linkId: string, patch: Partial<StoredMessage> = {}): StoredMessage => ({
  linkId, id: `m${++n}`, text: `hello ${n}`, sender: "peer", timestamp: 1_700_000_000_000 + n, via: "datalink", ...patch,
});
const node = (onState = vi.fn()) => new GhostlyNode({ onState, onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false });
const saved = async (engine = node()) => (await engine.savedMessages()).map(s => `${s.message.linkId}/${s.message.text}`);

const links = ["chat-a", "chat-b"], groups = ["mesh-1"];
afterEach(async () => {
  for (const id of links) await db.deleteLink(id);
  for (const id of groups) await db.deleteGroup(id);
  await wrap((await store(STORES.settings, "readwrite")).delete(SAVED_MESSAGES_KEY));
});

describe("saved messages", () => {
  it("saves messages of 1:1 chats and groups, lists the last saved first, and unsaves", async () => {
    const a = message("chat-a"), b = message("group:mesh-1", { member: "member-hermes" }), c = message("chat-b", { sender: "me" });
    for (const m of [a, b, c]) await db.addMessage(m);
    const onState = vi.fn(), engine = node(onState);
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: a.id })).toEqual({ error: null });
    expect(await engine.saveMessage({ linkId: "group:mesh-1", messageId: b.id })).toEqual({ error: null });
    expect(await engine.saveMessage({ linkId: "chat-b", messageId: c.id })).toEqual({ error: null });
    await vi.waitFor(() => expect(onState).toHaveBeenCalled());
    expect(await saved(engine)).toEqual([`chat-b/${c.text}`, `group:mesh-1/${b.text}`, `chat-a/${a.text}`]);
    const [first] = await engine.savedMessages();
    expect(first.message).toEqual(c);
    expect(typeof first.savedAt).toBe("number");

    // Saving again keeps the first mark and its place.
    await engine.saveMessage({ linkId: "chat-a", messageId: a.id });
    expect(await saved(engine)).toHaveLength(3);

    expect(await engine.saveMessage({ linkId: "group:mesh-1", messageId: b.id, remove: true })).toEqual({ error: null, removed: true });
    expect(await saved(engine)).toEqual([`chat-b/${c.text}`, `chat-a/${a.text}`]);
  });

  it("names a 1:1 message by the id both sides know too, and refuses one that is not there", async () => {
    const m = message("chat-a", { id: "peer_wire-1", wireId: "wire-1" });
    await db.addMessage(m);
    expect(await node().saveMessage({ linkId: "chat-a", messageId: "wire-1" })).toEqual({ error: null });
    expect((await node().savedMessages()).map(s => s.message.id)).toEqual(["peer_wire-1"]);
    expect(await node().saveMessage({ linkId: "chat-a", messageId: "wire-1", remove: true })).toEqual({ error: null, removed: true });
    expect(await node().savedMessages()).toEqual([]);

    expect(await node().saveMessage({ linkId: "chat-a", messageId: "nope" })).toEqual({ error: "That message is not in this chat" });
    expect(await node().saveMessage({ linkId: "group:mesh-1", messageId: "wire-1" })).toEqual({ error: "That message is not in this chat" });
    expect(await node().savedMessages()).toEqual([]);
  });

  // agents#1580: a typo'd id unsaved answered done, and the message meant stayed saved.
  it("unsaving an id that names neither a mark nor a message of the chat is not in this chat; one there but not saved is quietly so", async () => {
    const a = message("chat-a");
    await db.addMessage(a);
    const engine = node();
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: a.id })).toEqual({ error: null });
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: "no-such-id", remove: true })).toEqual({ error: "That message is not in this chat" });
    expect(await saved(engine)).toEqual([`chat-a/${a.text}`]);
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: a.id, remove: true })).toEqual({ error: null, removed: true });
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: a.id, remove: true })).toEqual({ error: null, removed: false });
    // A mark whose message is gone still goes.
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: a.id })).toEqual({ error: null });
    await db.deleteMessage("chat-a", a.id);
    expect(await engine.saveMessage({ linkId: "chat-a", messageId: a.id, remove: true })).toEqual({ error: null, removed: true });
  });

  it("keeps the marks across a restart: a new engine on the same profile reads them", async () => {
    const m = message("chat-a");
    await db.addMessage(m);
    await node().saveMessage({ linkId: "chat-a", messageId: m.id });
    expect(await saved(node())).toEqual([`chat-a/${m.text}`]);
  });

  it("shows an edit's latest text and drops a deleted message, chat or group", async () => {
    const one = message("chat-a"), two = message("chat-a"), three = message("chat-b"), four = message("group:mesh-1", { member: "member-hermes" });
    const engine = node();
    for (const m of [one, two, three, four]) { await db.addMessage(m); await engine.saveMessage({ linkId: m.linkId, messageId: m.id }); }

    await db.patchMessage("chat-a", two.id, () => ({ text: "edited", edit: { seq: 1, at: two.timestamp + 1000, history: [] } }));
    expect(await saved(engine)).toEqual([`group:mesh-1/${four.text}`, `chat-b/${three.text}`, "chat-a/edited", `chat-a/${one.text}`]);

    await db.deleteMessage("chat-a", one.id);
    await db.deleteLink("chat-b");
    await db.deleteGroup("mesh-1");
    expect(await saved(engine)).toEqual(["chat-a/edited"]);
    // The dropped marks are gone from the record too, so a row that comes back is not saved by itself.
    const record = await wrap((await store(STORES.settings, "readonly")).get(SAVED_MESSAGES_KEY)) as { items: { id: string }[] };
    expect(record.items.map(i => i.id)).toEqual([two.id]);
  });

  it("loses no mark when several are saved at once", async () => {
    const rows = Array.from({ length: 8 }, () => message("chat-a"));
    for (const m of rows) await db.addMessage(m);
    const engine = node();
    await Promise.all(rows.map(m => engine.saveMessage({ linkId: "chat-a", messageId: m.id })));
    expect(await saved(engine)).toHaveLength(8);
  });

  it("is the profile's: Clear all data deletes it", () => {
    expect(PROFILE_SETTINGS_KEYS).toContain(SAVED_MESSAGES_KEY);
  });
});
