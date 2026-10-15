import { appendFileSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { EventHub, JOURNAL_KEEP_BYTES, JOURNAL_MAX_BYTES, type GhostlyEvent } from "../src/events";
import { toTurn } from "../src/listen";
import { turnRef } from "../src/turnRefs";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events, headless.typing, headless.files

/**
 * The stream derived from the engine's own events: each fact once, with a stable id, across restarts; a first run
 * reports nothing of the history already there.
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-events-"));
  await openPersistentIndexedDb(join(dir, "db"));
});

const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "peer" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "dht", pairing: { status: "connecting" }, ...fields }) as unknown as LinkView;
const state = (links: LinkView[], groups: unknown[] = []) => ({ links, groups, settings: {}, transport: {} }) as unknown as EngineState;
const message = (linkId: string, id: string, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: "t " + id, sender: "peer", timestamp: 1, via: "datalink", ...fields });

async function hub(journal: string) {
  const h = new EventHub(join(dir, journal), () => 1000, journal);
  await h.open();
  const events: GhostlyEvent[] = [];
  h.onEvent((e) => events.push(e));
  return { h, events };
}

describe("the event stream", () => {
  it("never hands a new chat's invite code to a hook (chat.created)", async () => {
    const { h, events } = await hub("invite.jsonl");
    h.baseline(state([]), new Map());
    h.sink.post({ kind: "state", state: state([link("c9", { inviteCode: "ghostly1secret", pairing: { status: "waiting" } } as never)]) });
    const created = events.find((e) => e.type === "chat.created") as unknown as { summary: { invite: unknown } };
    expect(created.summary.invite).toBeNull();
    expect(JSON.stringify(events)).not.toContain("ghostly1secret");
  });

  it("reports messages, delivery changes, deletions, and chat changes once each", async () => {
    const { h, events } = await hub("a.jsonl");
    h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "old")]]]));
    expect(events).toEqual([]);
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "old"), message("c1", "new"), message("c1", "me_1", { sender: "me", delivery: "sending" })] });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "old"), message("c1", "new"), message("c1", "me_1", { sender: "me", delivery: "delivered" })] });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "new"), message("c1", "me_1", { sender: "me", delivery: "delivered" })] });
    h.sink.post({ kind: "state", state: state([link("c1", { textDelivery: "stream", dataLink: "open", pairing: { status: "ready", transport: "hyperdht/1" }, pairingProgress: { stage: "live" } as never }), link("c2")]) });
    h.sink.post({ kind: "state", state: state([link("c2", { label: "bot" })]) });
    const signals: [string, string][] = [];
    h.onCallSignal((chat, signal) => signals.push([chat, signal]));
    h.sink.post({ kind: "call-signal", linkId: "c2", signal: JSON.stringify({ t: "o" }) });
    // Calls are the call manager's to report (src/calls/manager.ts): the hub hands their signals on.
    expect(signals).toEqual([["c2", '{"t":"o"}']]);
    expect(events.map((e) => [e.seq, e.id])).toEqual([
      [1, "message.received:c1:new"],
      [2, "message.sent:c1:me_1"],
      [3, "message.delivery:c1:me_1:delivered"],
      [4, "message.deleted:c1:old"],
      [5, "chat.pairing:c1:live:1000"],
      [6, "chat.connection:c1:hyperdht/1:1000"],
      [7, "chat.created:c2"],
      [8, "chat.renamed:c2:1000"],
      [9, "chat.removed:c1"],
    ]);
    expect(events[0]).toMatchObject({ type: "message.received", chat: "c1", message: { id: "new", from: "peer", text: "t new" } });
    expect(events[5]).toMatchObject({ live: true, transport: "hyperdht/1" });
  });

  it("names the contact on a 1:1 message, so an agent turn carries their name (the engine keeps it on the chat)", async () => {
    const { h, events } = await hub("names.jsonl");
    h.baseline(state([link("c1", { peerNick: "Alice", label: "owner" } as never)]), new Map([["c1", []]]));
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "in"), message("c1", "me_1", { sender: "me", delivery: "sending" })] });
    const [received, sent] = events;
    expect(received).toMatchObject({ type: "message.received", message: { id: "in", nick: "Alice" } });
    // The label is this side's own name for the chat: `untrusted.name` is only what the contact calls themselves.
    expect(toTurn(received)).toMatchObject({ untrusted: { text: "t in", name: "Alice" } });
    expect(sent).toMatchObject({ type: "message.sent", message: { id: "me_1", nick: null } });
  });

  it("reports the same events from only what changed as from the whole history, a deletion included", async () => {
    const run = async (journal: string, changesOnly: boolean) => {
      const { h, events } = await hub(journal);
      h.baseline(state([link("c1")], [{ id: "g1", members: [] }]), new Map([["c1", [message("c1", "old")]], ["group:g1", [message("group:g1", "x", { member: "k1" })]]]));
      const whole = new Map([["c1", [message("c1", "old")]], ["group:g1", [message("group:g1", "x", { member: "k1" })]]]);
      const change = (chat: string, rows: StoredMessage[], deleted: string[] = []) => {
        const list = [...whole.get(chat)!.filter((m) => !deleted.includes(m.id) && !rows.some((r) => r.id === m.id)), ...rows];
        whole.set(chat, list);
        h.sink.post(changesOnly ? { kind: "message-changes", linkId: chat, messages: rows, deleted } : { kind: "messages", linkId: chat, messages: list });
      };
      change("c1", [message("c1", "me_1", { sender: "me", delivery: "sending" })]);
      change("c1", [message("c1", "me_1", { sender: "me", delivery: "delivered", edit: { seq: 1, at: 2, history: [] } })]);
      change("c1", [message("c1", "new", { reactions: { peer: { e: "👍", n: 1, at: 3 } } })]);
      change("c1", [], ["old"]);
      change("group:g1", [message("group:g1", "x", { member: "k1", text: "x2", edit: { seq: 1, at: 4, history: [] } })]);
      change("group:g1", [message("group:g1", "y", { member: "k1" })], ["x"]);
      return events.map((e) => e.id);
    };
    const whole = await run("whole.jsonl", false);
    expect(whole).toContain("message.deleted:c1:old");
    expect(whole).toContain("group.deleted:g1:x");
    expect(await run("changes.jsonl", true)).toEqual(whole);
  });

  it("says when a contact starts and stops typing, once per change", async () => {
    const { h, events } = await hub("typing.jsonl");
    h.baseline(state([link("c1")]), new Map());
    h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true })]) });
    h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true })]) });
    h.sink.post({ kind: "state", state: state([link("c1")]) });
    expect(events.map((e) => [e.type, e.id, e.chat, e.kind])).toEqual([
      ["typing.started", "typing.started:c1:1000", "c1", "typing"],
      ["typing.stopped", "typing.stopped:c1:1000", "c1", undefined],
    ]);
  });

  it("a start says what the contact is doing, and a change while it lasts is a start again", async () => {
    const { h, events } = await hub("typing-kinds.jsonl");
    h.baseline(state([link("c1")]), new Map());
    h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true, peerTypingKind: "recording" })]) });
    h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true, peerTypingKind: "thinking" })]) });
    h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true, peerTypingKind: "thinking", peerTypingStatus: "Transcribing your audio…" })]) });
    h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true, peerTypingKind: "thinking", peerTypingStatus: "Transcribing your audio…" })]) });
    h.sink.post({ kind: "state", state: state([link("c1")]) });
    expect(events.map(({ type, chat, kind, status }) => ({ type, chat, kind, status }))).toEqual([
      { type: "typing.started", chat: "c1", kind: "recording", status: undefined },
      { type: "typing.started", chat: "c1", kind: "thinking", status: undefined },
      { type: "typing.started", chat: "c1", kind: "thinking", status: "Transcribing your audio…" },
      { type: "typing.stopped", chat: "c1", kind: undefined, status: undefined },
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("says when a member of a group starts and stops typing, with what it does, once per change", async () => {
    const { h, events } = await hub("group-typing.jsonl");
    const group = (typing?: unknown[]) => ({ id: "g1", status: "active", members: [{ key: "ana" }, { key: "bo" }], ...(typing ? { typing } : {}) });
    h.baseline(state([], [group()]), new Map());
    h.sink.post({ kind: "state", state: state([], [group([{ key: "ana" }])]) });
    h.sink.post({ kind: "state", state: state([], [group([{ key: "ana" }, { key: "bo", kind: "thinking", status: "Reading" }])]) });
    h.sink.post({ kind: "state", state: state([], [group([{ key: "ana", kind: "recording" }, { key: "bo", kind: "thinking", status: "Reading" }])]) });
    h.sink.post({ kind: "state", state: state([], [group([{ key: "bo", kind: "thinking", status: "Reading" }])]) });
    h.sink.post({ kind: "state", state: state([], [group()]) });
    expect(events.map(({ type, group, member, kind, status }) => ({ type, group, member, kind, status }))).toEqual([
      { type: "group.typing.started", group: "g1", member: "ana", kind: "typing", status: undefined },
      { type: "group.typing.started", group: "g1", member: "bo", kind: "thinking", status: "Reading" },
      { type: "group.typing.started", group: "g1", member: "ana", kind: "recording", status: undefined },
      { type: "group.typing.stopped", group: "g1", member: "ana", kind: undefined, status: undefined },
      { type: "group.typing.stopped", group: "g1", member: "bo", kind: undefined, status: undefined },
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("notes what it reported with relaxed transactions: a message's delivery states cost the daemon no disk sync each", async () => {
    const { h } = await hub("relaxed.jsonl");
    const db = (h as unknown as { db: IDBDatabase }).db;
    const transaction = vi.spyOn(db, "transaction");
    h.baseline(state([link("c1")]), new Map([["c1", []]]));
    for (const delivery of ["sending", "sent", "delivered"] as const)
      h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "me_1", { sender: "me", delivery })] });
    const writes = transaction.mock.calls.filter(([, mode]) => mode === "readwrite");
    expect(writes.length).toBe(4);
    expect(writes.map(([, , options]) => options)).toEqual(writes.map(() => ({ durability: "relaxed" })));
    transaction.mockRestore();

    // Still read back by the next run: nothing is reported twice.
    await new Promise((r) => setTimeout(r, 50));
    const second = await hub("relaxed.jsonl");
    second.h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "me_1", { sender: "me", delivery: "delivered" })]]]));
    expect(second.events).toEqual([]);
  });

  it("after a restart: seq goes on, only what is new is reported, and the journal replays", async () => {
    const first = await hub("b.jsonl");
    first.h.baseline(state([link("c1")]), new Map([["c1", []]]));
    first.h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "m1")] });
    expect(first.events.map((e) => e.seq)).toEqual([1]);

    const second = await hub("b.jsonl");
    // m2 came while nothing derived events (a crash): it is news; m1 is not.
    second.h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "m1"), message("c1", "m2")]]]));
    expect(second.events.map((e) => [e.seq, e.id])).toEqual([[2, "message.received:c1:m2"]]);
    expect(second.h.replay(0).map((e) => e.seq)).toEqual([1, 2]);
    expect(second.h.replay(1).map((e) => e.seq)).toEqual([2]);
    expect(second.h.replay(2)).toEqual([]);
  });

  it("tells a chat in step by its newest messages alone: nothing of them is news, and what changes next is", async () => {
    const old = message("c1", "m1"), mine = message("c1", "me_2", { sender: "me", delivery: "delivered", reactions: { peer: { e: "👍", n: 1, at: 1 } } }), last = message("c1", "m3");
    const first = await hub("step.jsonl");
    // A first run takes the whole history, however it looks.
    expect(first.h.inStep("c1", [mine, last])).toBe(false);
    first.h.baseline(state([link("c1")]), new Map([["c1", [old, mine, last]]]));
    await new Promise((r) => setTimeout(r, 50));

    const second = await hub("step.jsonl");
    expect(second.h.inStep("c1", [mine, last])).toBe(true);
    // One not reported yet, a delivery, an edit or a reaction that changed since: the whole history is due.
    expect(second.h.inStep("c1", [last, message("c1", "m4")])).toBe(false);
    expect(second.h.inStep("c1", [{ ...mine, delivery: "failed" }, last])).toBe(false);
    expect(second.h.inStep("c1", [mine, { ...last, edit: { seq: 1, at: 5, history: [] } }])).toBe(false);
    expect(second.h.inStep("c1", [{ ...mine, reactions: { peer: { e: "", n: 2, at: 2 } } }, last])).toBe(false);
    expect(second.h.inStep("c2", [message("c2", "x")])).toBe(false);

    second.h.baseline(state([link("c1")]), new Map(), { newest: new Map([["c1", [mine, last]]]), whole: async () => [old, mine, last] });
    expect(second.events).toEqual([]);
    // The message the baseline did not read is still known: its edit is an edit, a new message is news, and nothing is deleted.
    second.h.sink.post({ kind: "message-changes", linkId: "c1", messages: [{ ...old, edit: { seq: 1, at: 5, history: [] } }, message("c1", "m4")], deleted: [] });
    expect(second.events.map((e) => e.id)).toEqual(["message.edited:c1:m1:1", "message.received:c1:m4"]);
  });

  it("reports group messages, mentions included", async () => {
    const { h, events } = await hub("c.jsonl");
    h.baseline(state([], [{ id: "g1", name: "G", members: [], isAdmin: false, canSend: true, lastMessageAt: 0, profile: "community", invited: [], memberLinks: {}, createdAt: 1 }]), new Map([["group:g1", []]]));
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [message("group:g1", "x", { member: "k1", mentioned: true, mentions: [{ k: "me", o: 0, l: 3 }] }), message("group:g1", "j", { event: "joined" })] });
    expect(events.map((e) => e.id)).toEqual(["group.message:g1:x", "group.event:g1:j"]);
    expect(events[0]).toMatchObject({ group: "g1", message: { member: "k1", mentioned: true, mentions: [{ key: "me", offset: 0, length: 3 }] } });
  });

  it("reports a mention learned after its group.message once (a stripped copy completed), and not again after a restart", async () => {
    const g1 = { id: "g1", name: "G", members: [], isAdmin: false, canSend: true, lastMessageAt: 0, profile: "mesh", invited: [], memberLinks: {}, createdAt: 1 };
    const { h, events } = await hub("late-mention.jsonl");
    h.baseline(state([], [g1]), new Map([["group:g1", []]]));
    // Handed on without its author's whole signature: the text, no mentions.
    const stripped = message("group:g1", "x", { member: "k1", text: "@me look" });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [stripped] });
    // The author's whole copy completes it: the mention of me.
    const whole = { ...stripped, mentioned: true as const, mentions: [{ k: "me", o: 0, l: 3 }] };
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [whole] });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [whole] });
    expect(events.map((e) => e.id)).toEqual(["group.message:g1:x", "group.mentioned:g1:x"]);
    expect(events[1]).toMatchObject({ type: "group.mentioned", group: "g1", messageId: "x", message: { id: "x", member: "k1", mentioned: true } });
    expect(toTurn(events[1]!)).toMatchObject({ id: `agent.turn:group.mentioned:g1:${turnRef("g1", "x")}`, source: "group.mentioned", group: "g1", member: "k1", messageId: turnRef("g1", "x"), untrusted: { text: "@me look", messageId: "x" } });
    // An edit that drops the mention and one that names me again: the edits, not the mention again.
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [{ ...stripped, edit: { seq: 1, at: 2, history: [] } }] });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [{ ...whole, edit: { seq: 2, at: 3, history: [] } }] });
    expect(events.map((e) => e.type)).toEqual(["group.message", "group.mentioned", "group.message.edited", "group.message.edited"]);
    // A mention there from the start says so on its group.message only.
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [message("group:g1", "y", { member: "k1", mentioned: true })], deleted: [] });
    expect(events.at(-1)!.id).toBe("group.message:g1:y");
    // Restarted: what was reported stays reported.
    const again = await hub("late-mention.jsonl");
    again.h.baseline(state([], [g1]), new Map([["group:g1", [{ ...whole, edit: { seq: 2, at: 3, history: [] } }, message("group:g1", "y", { member: "k1", mentioned: true })]]]));
    expect(again.events).toEqual([]);
  });

  it("a seen set from before mentions were noted reports none of its old mentions again", async () => {
    const g1 = { id: "g1", name: "G", members: [], isAdmin: false, canSend: true, lastMessageAt: 0, profile: "mesh", invited: [], memberLinks: {}, createdAt: 1 };
    const { h } = await hub("old-set.jsonl");
    h.baseline(state([], [g1]), new Map([["group:g1", []]]));
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [message("group:g1", "x", { member: "k1" })] });
    // As an older release left it: the message seen as `received`, and no note that the set tracks mentions.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("old-set.jsonl");
      request.onsuccess = () => {
        const tx = request.result.transaction("seen", "readwrite");
        tx.objectStore("seen").delete(["format:", "mentions"]);
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const upgraded = await hub("old-set.jsonl");
    upgraded.h.baseline(state([], [g1]), new Map([["group:g1", [message("group:g1", "x", { member: "k1", mentioned: true })]]]));
    expect(upgraded.events).toEqual([]);
    // From then on a late mention is reported.
    upgraded.h.sink.post({ kind: "messages", linkId: "group:g1", messages: [message("group:g1", "x", { member: "k1", mentioned: true }), message("group:g1", "z", { member: "k1" })] });
    upgraded.h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [message("group:g1", "z", { member: "k1", mentioned: true })], deleted: [] });
    expect(upgraded.events.map((e) => e.id)).toEqual(["group.message:g1:z", "group.mentioned:g1:z"]);
  });

  it("a group left (its history gone, sent empty) deletes nothing it reports, and a message there after a new join is new", async () => {
    const { h, events } = await hub("left.jsonl");
    h.baseline(state([], [{ id: "g1", members: [] }]), new Map([["group:g1", []]]));
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [message("group:g1", "x", { member: "k1" })] });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [] });
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [message("group:g1", "y", { member: "k1" })], deleted: [] });
    expect(events.map((e) => e.id)).toEqual(["group.message:g1:x", "group.message:g1:y"]);
  });

  it("reads a large seen set at start in two requests, without a cursor step per row", async () => {
    const history = (chat: string) => Array.from({ length: 2_000 }, (_, i) => message(chat, `m${i}`, i % 2 ? { sender: "me", delivery: "delivered" } : {}));
    const first = await hub("large.jsonl");
    first.h.baseline(state([link("c1"), link("c2")]), new Map([["c1", history("c1")], ["c2", history("c2")]]));
    // The seen set is written behind the baseline: a read queued after it runs once those rows are in.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("large.jsonl");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store = db.transaction("seen").objectStore("seen");
    const proto = Object.getPrototypeOf(store) as IDBObjectStore;
    expect(await new Promise<number>((resolve) => { const request = store.count(); request.onsuccess = () => resolve(request.result); })).toBeGreaterThanOrEqual(4_000);
    db.close();
    const cursors = vi.spyOn(proto, "openCursor");
    const requests = [vi.spyOn(proto, "getAllKeys"), vi.spyOn(proto, "getAll"), vi.spyOn(proto, "get")];
    const later = await hub("large.jsonl");
    expect(cursors).not.toHaveBeenCalled();
    expect(requests.reduce((n, spy) => n + spy.mock.calls.length, 0)).toBe(2);
    vi.restoreAllMocks();
    // Every row is back under its own chat and message: nothing is reported twice, a delivery change and a new message are.
    later.h.baseline(state([link("c1"), link("c2")]), new Map([["c1", history("c1")], ["c2", [...history("c2").slice(0, 1_999), message("c2", "m1999", { sender: "me", delivery: "failed" }), message("c2", "fresh")]]]));
    expect(later.events.map((e) => e.id)).toEqual(["message.delivery:c2:m1999:failed", "message.received:c2:fresh"]);
  });

  it("says when the journal no longer holds what a listener asks for", async () => {
    const { h } = await hub("d.jsonl");
    const lines = [5, 6].map((seq) => JSON.stringify({ seq, id: `x:${seq}`, type: "x", at: 1 })).join("\n") + "\n";
    writeFileSync(join(dir, "d.jsonl"), lines);
    const again = new EventHub(join(dir, "d.jsonl"), () => 1000, "d2");
    await again.open();
    expect(again.lastSeq).toBe(6);
    expect(again.replay(2).map((e) => e.type)).toEqual(["events.gap", "x", "x"]);
    expect(again.replay(2)[0]).toMatchObject({ from: 3, to: 4 });
    void h;
  });

  it("a journal past the longest string still opens, replays and is cut to its bound in bytes", async () => {
    const path = join(dir, "huge.jsonl");
    // 600 MiB, more characters than a string can hold, mostly a hole on disk; then whole events.
    truncateSync((writeFileSync(path, ""), path), 600 * 1024 * 1024);
    appendFileSync(path, "\n" + [7, 8, 9].map((seq) => JSON.stringify({ seq, id: `x:${seq}`, type: "x", at: 1 })).join("\n") + "\n");
    const h = new EventHub(path, () => 1000, "huge");
    await h.open();
    expect(h.lastSeq).toBe(9);
    expect(statSync(path).size).toBeLessThanOrEqual(JOURNAL_KEEP_BYTES);
    expect(h.replay(7).map((e) => e.seq)).toEqual([8, 9]);
    const heard: number[] = [];
    h.onEvent((e) => heard.push(e.seq));
    h.emit("daemon.started", "daemon.started:1");
    expect(heard).toEqual([10]);
  }, 30_000);

  it("keeps the journal within its bytes however long the events, and still replays its end", async () => {
    const { h, events } = await hub("long.jsonl");
    // Quotes take twice their length in JSON: each event is about 256 KiB of journal.
    const text = '"'.repeat(128 * 1024);
    for (let i = 0; i < 300; i++) {
      h.emit("x", `x:${i}`, { text });
      expect(statSync(join(dir, "long.jsonl")).size).toBeLessThanOrEqual(JOURNAL_MAX_BYTES);
    }
    expect(events).toHaveLength(300);
    const replayed = h.replay(0);
    expect(replayed[0].type).toBe("events.gap");
    expect(replayed.at(-1)!.seq).toBe(300);
    expect(replayed.slice(1).map((e) => e.seq)).toEqual(Array.from({ length: replayed.length - 1 }, (_, i) => 302 - replayed.length + i));
  }, 60_000);

  it("a first run learns the history without reporting it; a later one reports what came meanwhile", async () => {
    const first = await hub("e.jsonl");
    first.h.baseline(state([link("c9")]), new Map([["c9", [message("c9", "a"), message("c9", "b")]]]));
    expect(first.events).toEqual([]);
    const later = await hub("e.jsonl");
    later.h.baseline(state([link("c9")]), new Map([["c9", [message("c9", "a"), message("c9", "b"), message("c9", "c")]]]));
    expect(later.events.map((e) => e.id)).toEqual(["message.received:c9:c"]);
    expect(readFileSync(join(dir, "e.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  describe("files", () => {
    afterEach(() => { vi.useRealTimers(); });
    const voice = { id: "c1-in-v", name: "Voice.webm", size: 900, mime: "audio/webm", voice: { duration: 11_000, peaks: [0, 40, 255] } };
    const transfers = (entries: Record<string, unknown>) => ({ ...state([link("c1")]), transfers: entries }) as unknown as EngineState;

    it("a file message carries the file: its id, and a voice note's length and bars", async () => {
      const { h, events } = await hub("f1.jsonl");
      h.baseline(state([link("c1")]), new Map([["c1", []]]));
      h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "peer_v", { text: "🎤 Voice message (0:11)", file: voice })] });
      expect(events[0]).toMatchObject({ type: "message.received", message: { id: "peer_v", file: { id: "c1-in-v", name: "Voice.webm", size: 900, mime: "audio/webm", voice: { duration: 11_000, peaks: [0, 40, 255] } } } });
    });

    it("file.done and file.failed name the message and the chat", async () => {
      const { h, events } = await hub("f2.jsonl");
      h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "peer_v", { file: voice })]]]));
      h.sink.post({ kind: "state", state: transfers({ "c1-in-v": { state: "transferring", transferred: 0, size: 900, direction: "in", stage: "queued" } }) });
      h.sink.post({ kind: "state", state: transfers({ "c1-in-v": { state: "done", transferred: 900, size: 900, direction: "in" } }) });
      h.sink.post({ kind: "state", state: transfers({ "c1-in-v": { state: "done", transferred: 900, size: 900, direction: "in" }, "c1-out-w": { state: "failed", transferred: 5, size: 9, error: "Cancelled", retry: true } }) });
      expect(events.map((e) => [e.type, e.file, e.chat, e.messageId])).toEqual([
        ["file.stage", "c1-in-v", "c1", "peer_v"],
        ["file.done", "c1-in-v", "c1", "peer_v"],
      ]);
      // The failed one's message was never seen: it waits for it, then goes with it.
      h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "peer_v", { file: voice }), message("c1", "me_9", { sender: "me", delivery: "sent", file: { id: "c1-out-w", name: "a", size: 9, mime: "text/plain" } })] });
      expect(events.slice(2).map((e) => [e.type, e.messageId ?? (e.message as { id: string }).id])).toEqual([["message.sent", "me_9"], ["file.failed", "me_9"]]);
      expect(events[3]).toMatchObject({ chat: "c1", file: "c1-out-w", error: "Cancelled", retry: true });
    });

    it("a file of a message older than the baseline read names its message: the history is read then, once", async () => {
      const older = message("c1", "peer_v", { file: voice }), other = message("c1", "peer_w", { file: { ...voice, id: "c1-in-w" } }), last = message("c1", "m9");
      const first = await hub("f4.jsonl");
      first.h.baseline(state([link("c1")]), new Map([["c1", [older, other, last]]]));
      await new Promise((r) => setTimeout(r, 50));

      const { h, events } = await hub("f4.jsonl");
      const whole = vi.fn(async () => [older, other, last]);
      h.baseline(state([link("c1")]), new Map(), { newest: new Map([["c1", [last]]]), whole });
      expect(whole).not.toHaveBeenCalled();
      h.sink.post({ kind: "state", state: transfers({ "c1-in-v": { state: "done", transferred: 900, size: 900, direction: "in" } }) });
      await vi.waitFor(() => expect(events.map((e) => [e.type, e.file, e.messageId])).toEqual([["file.done", "c1-in-v", "peer_v"]]));
      h.sink.post({ kind: "state", state: transfers({ "c1-in-v": { state: "done", transferred: 900, size: 900, direction: "in" }, "c1-in-w": { state: "failed", transferred: 5, size: 900, direction: "in", error: "Cancelled" } }) });
      expect(events.map((e) => [e.type, e.file, e.messageId])).toEqual([["file.done", "c1-in-v", "peer_v"], ["file.failed", "c1-in-w", "peer_w"]]);
      expect(whole.mock.calls).toEqual([["c1"]]);
    });

    it("a file event whose message never comes goes after a moment, with messageId null", async () => {
      const { h, events } = await hub("f3.jsonl");
      h.baseline(state([link("c1")]), new Map([["c1", []]]));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      h.sink.post({ kind: "state", state: transfers({ "c1-in-z": { state: "transferring", transferred: 0, size: 9, direction: "in", stage: "asking", room: 100 } }) });
      expect(events).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(events).toMatchObject([{ type: "file.offered", file: "c1-in-z", chat: "c1", messageId: null, room: 100 }]);
    });
  });
});

/**
 * The seen set forgets (SEEN_KEEP_MS): a note per message of the whole history, kept in memory for as long as a daemon
 * ran, was ~150 bytes a message. A settled message's note goes 30 days after its last activity, and a message that came
 * longer ago with no note is no news; what happens to it later still is.
 */
describe("the seen set forgets", () => {
  const DAY = 86_400_000;
  const clock = { now: 0 };
  async function clocked(name: string) {
    const h = new EventHub(join(dir, name), () => clock.now, name);
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    return { h, events };
  }
  const notes = (h: EventHub) => (h as unknown as { seen: Map<string, Map<string, string>> }).seen;
  const storedKeys = (h: EventHub) => new Promise<unknown[]>((resolve, reject) => {
    const request = (h as unknown as { db: IDBDatabase }).db.transaction("seen").objectStore("seen").getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  it("drops settled notes 30 days after their last activity, from memory and the store; those messages are no news, what changes in them is", async () => {
    const m1 = message("c1", "m1", { timestamp: 1 * DAY, reactions: { me: { e: "👍", n: 1, at: 2 * DAY } } });
    const me1 = message("c1", "me_1", { sender: "me", delivery: "delivered", timestamp: 1 * DAY });
    const me2 = message("c1", "me_2", { sender: "me", delivery: "failed", timestamp: 1 * DAY });
    const m3 = message("c1", "m3", { timestamp: 20 * DAY });
    clock.now = 25 * DAY;
    const { h, events } = await clocked("forget.jsonl");
    h.baseline(state([link("c1")]), new Map([["c1", [m1, me1, me2, m3]]]));
    h.markSaid("c1", "joined");

    clock.now = 41 * DAY;
    // m1, its reaction and me_1: settled, last active more than 30 days ago. me_2 failed (a retry sends it again), m3 is recent.
    expect(h.sweep()).toBe(3);
    expect([...notes(h).get("c1")!.keys()].sort()).toEqual(["m3", "me_2"]);
    expect(notes(h).has("reactions:c1")).toBe(false);
    expect(h.said("c1", "joined")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect((await storedKeys(h)).filter((k) => (k as string[])[0] === "c1" || (k as string[])[0] === "reactions:c1").map((k) => (k as string[])[1]).sort()).toEqual(["m3", "me_2"]);

    // The whole history again (a client behind, a restart): nothing of it is news.
    h.sink.post({ kind: "messages", linkId: "c1", messages: [m1, me1, me2, m3] });
    expect(events).toEqual([]);
    expect(notes(h).get("c1")!.has("m1")).toBe(false);
    // An edit of a forgotten message is reported, and its note comes back; a new message is news as ever.
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [{ ...m1, edit: { seq: 1, at: 40 * DAY, history: [] } }, message("c1", "m4", { timestamp: 41 * DAY })], deleted: [] });
    expect(events.map((e) => e.id)).toEqual(["message.edited:c1:m1:1", "message.received:c1:m4"]);
    expect(notes(h).get("c1")!.has("m1")).toBe(true);

    // After a restart, a chat whose newest messages' notes were dropped is still in step: no whole read at each start.
    await new Promise((r) => setTimeout(r, 50));
    const again = await clocked("forget.jsonl");
    expect(again.h.inStep("c1", [me1, me2])).toBe(true);
    // One active since (a reaction now) is not.
    expect(again.h.inStep("c1", [{ ...me1, reactions: { peer: { e: "❤️", n: 1, at: 40 * DAY } } }, me2])).toBe(false);
  });

  it("a seen set from before notes carried their time: the first start reads every history whole, stamps the notes, then drops the old ones", async () => {
    clock.now = 41 * DAY;
    // As an older release left it: `received` with no time, and the mark that it notes mentions.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("aged.jsonl", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("seen");
      request.onsuccess = () => {
        const tx = request.result.transaction("seen", "readwrite");
        tx.objectStore("seen").put("received", ["c1", "m1"]);
        tx.objectStore("seen").put("received", ["c1", "m2"]);
        tx.objectStore("seen").put("yes", ["format:", "mentions"]);
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const { h, events } = await clocked("aged.jsonl");
    const m1 = message("c1", "m1", { timestamp: 1 * DAY }), m2 = message("c1", "m2", { timestamp: 40 * DAY });
    expect(h.inStep("c1", [m1, m2])).toBe(false);
    h.baseline(state([link("c1")]), new Map([["c1", [m1, m2]]]));
    expect(events).toEqual([]);
    // m1 stamped with its time and dropped at once (41 days old), m2 kept with its time.
    expect([...notes(h).get("c1")!.entries()]).toEqual([["m2", `received@${(40 * DAY).toString(36)}`]]);
    expect(notes(h).get("format:")!.get("ages")).toBe("yes");
    await new Promise((r) => setTimeout(r, 50));
    expect((await clocked("aged.jsonl")).h.inStep("c1", [m1, m2])).toBe(true);
  });
});
