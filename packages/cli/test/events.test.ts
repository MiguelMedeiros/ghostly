import { appendFileSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { EventHub, JOURNAL_KEEP_BYTES, JOURNAL_MAX_BYTES, SEEN_KEEP_MS, type GhostlyEvent } from "../src/events";
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
    // The contact's key goes with the removal: `listen --from <key>` can no longer ask the daemon for a chat that is gone.
    expect(events[8]).toMatchObject({ type: "chat.removed", chat: "c1", peer: "peerc1" });
  });

  it("gives a delivery a message comes back to an id of its own, also after a restart (a listener dedupes on it)", async () => {
    const first = await hub("again.jsonl");
    first.h.baseline(state([link("c1")]), new Map([["c1", []]]));
    const deliver = (h: EventHub, delivery: StoredMessage["delivery"]) => h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "me_1", { sender: "me", delivery })] });
    // The contact's daemon went away before its receipt: the text goes again, and fails twice before it is delivered.
    for (const delivery of ["sending", "sent", "queued", "sending", "sent", "failed", "sending"] as const) deliver(first.h, delivery);
    // The seen set is written behind the events, and read again by the next run's hub: it goes on counting from it.
    const later = await hub("again.jsonl");
    later.h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "me_1", { sender: "me", delivery: "sending" })]]]));
    for (const delivery of ["failed", "sending", "delivered"] as const) deliver(later.h, delivery);
    const ids = [...first.events, ...later.events].map((e) => e.id);
    expect(ids).toEqual([
      "message.sent:c1:me_1",
      "message.delivery:c1:me_1:sent",
      "message.delivery:c1:me_1:queued",
      "message.delivery:c1:me_1:sending:3",
      "message.delivery:c1:me_1:sent:4",
      "message.delivery:c1:me_1:failed",
      "message.delivery:c1:me_1:sending:6",
      "message.delivery:c1:me_1:failed:7",
      "message.delivery:c1:me_1:sending:8",
      "message.delivery:c1:me_1:delivered",
    ]);
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

  it("a contact's message in the words of a joined line is a message: only the row the engine took as that line is chat.joined", async () => {
    const { h, events } = await hub("joined.jsonl");
    h.baseline(state([link("c1")]), new Map([["c1", []]]));
    h.sink.post({ kind: "messages", linkId: "c1", messages: [
      message("c1", "peer_1", { text: "👋 Bob joined", joinLine: true }),
      message("c1", "peer_2", { text: "👋 I just joined" }),
      message("c1", "peer_3", { text: "👋 joined" }),
      message("c1", "me_4", { sender: "me", text: "👋 Bot joined", delivery: "sending" }),
    ] });
    expect(events.map((e) => [e.type, (e as { name?: unknown }).name ?? null])).toEqual([
      ["chat.joined", "Bob"],
      ["message.received", null],
      ["message.received", null],
      ["chat.announced", "Bot"],
    ]);
    expect(toTurn(events[1]!)).toMatchObject({ untrusted: { text: "👋 I just joined" } });
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

  it("a contact's proof back at a status it had before is a new fact, with its own id and the reason", async () => {
    const { h, events } = await hub("identity-status.jsonl");
    h.baseline(state([link("c1")]), new Map());
    const proof = (status: string, error?: string) => link("c1", { identities: { support: true, shared: [], received: [{ id: "p1", provider: "domain", subject: "example.com", status, verified: {}, verifiedAt: 1, checkedAt: 1, expiresAt: 0, recheckDue: false, ...(error ? { error } : {}) }] } } as never);
    for (const [status, error] of [["verified"], ["unconfirmed", "No TXT record at _ghostly.example.com"], ["verified"], ["unconfirmed", "The resolver did not answer"], ["unconfirmed", "The resolver did not answer"]]) {
      h.sink.post({ kind: "state", state: state([proof(status!, error)]) });
    }
    const changes = events.map((e) => ({ type: e.type, ...(e.identity as { status: string; error: string | null }) })).map(({ type, status, error }) => ({ type, status, error }));
    expect(changes).toEqual([
      { type: "identity.received", status: "verified", error: null },
      { type: "identity.status", status: "unconfirmed", error: "No TXT record at _ghostly.example.com" },
      { type: "identity.status", status: "verified", error: null },
      { type: "identity.status", status: "unconfirmed", error: "The resolver did not answer" },
    ]);
    // A listener that dedupes by id (README) keeps every change.
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

  it("typing is live only: a contact who keeps changing it pushes no other chat's events out of the journal", async () => {
    const { h, events } = await hub("typing-live.jsonl");
    const group = (typing?: unknown[]) => ({ id: "g1", status: "active", members: [{ key: "ana" }], ...(typing ? { typing } : {}) });
    h.baseline(state([link("c1"), link("c2")], [group()]), new Map([["c1", []], ["c2", []]]));
    h.sink.post({ kind: "messages", linkId: "c2", messages: [message("c2", "m1")] });
    // A status that changes at the rate the receiver allows: each change a start again, then a stop.
    for (let i = 0; i < 40; i++) {
      h.sink.post({ kind: "state", state: state([link("c1", { peerTyping: true, peerTypingKind: "thinking", peerTypingStatus: `step ${i}` }), link("c2")], [group([{ key: "ana", kind: "thinking", status: `step ${i}` }])]) });
    }
    h.sink.post({ kind: "state", state: state([link("c1"), link("c2")], [group()]) });
    h.sink.post({ kind: "messages", linkId: "c2", messages: [message("c2", "m1"), message("c2", "m2")] });
    // The listeners hear every change, each with its own id, carrying the last journaled event's seq.
    const typing = events.filter((e) => e.type.includes("typing."));
    expect(typing).toHaveLength(82);
    expect(new Set(typing.map((e) => e.id)).size).toBe(typing.length);
    expect(typing.every((e) => e.seq === 1)).toBe(true);
    // The journal holds the two messages only, numbered one after the other.
    expect(h.replay(0).map((e) => [e.seq, e.type])).toEqual([[1, "message.received"], [2, "message.received"]]);
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
    // The daemon stops: the seqs it reserved and did not use go back (`release`), so the next start goes on by one.
    first.h.release();

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

  /**
   * What the person removes leaves holes in the seqs (`forget`): none is a gap. Before, a cursor that stopped right before
   * a message deleted, a chat removed or a group left got an `events.gap` for it, and one a step earlier did not.
   */
  it("a message deleted, a chat removed or a group left is no gap after a cursor, before and after a restart", async () => {
    const path = join(dir, "holes.jsonl");
    const { h } = await hub("holes.jsonl");
    h.baseline(state([link("c1"), link("c2")], [{ id: "g1", status: "active", members: [{ key: "ana" }] }]), new Map());
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "m1"), message("c1", "m2"), message("c1", "m3")], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "c2", messages: [message("c2", "x")], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [message("group:g1", "y", { member: "ana" })], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "m4")], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m2"] });
    h.sink.post({ kind: "state", state: state([link("c1")], [{ id: "g1", status: "active", members: [{ key: "ana" }] }]) });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [] });
    h.sink.post({ kind: "state", state: state([link("c1")]) });
    // The journal's first event goes too.
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m1"] });
    const check = (hub: EventHub) => {
      const held = hub.replay(0).map((e) => e.seq);
      expect(held).not.toContain(0);
      const holes = Array.from({ length: hub.lastSeq }, (_, i) => i + 1).filter((seq) => !held.includes(seq));
      expect(holes).toEqual([1, 2, 4, 5]);
      for (let since = 0; since < hub.lastSeq; since++) {
        const replayed = hub.replay(since);
        expect(replayed.map((e) => e.type)).not.toContain("events.gap");
        expect(replayed.map((e) => e.seq)).toEqual(held.filter((seq) => seq > since));
      }
    };
    check(h);
    h.release();
    const again = new EventHub(path, () => 1000, "holes-again");
    await again.open();
    check(again);
  });

  it("a journal trimmed says what it dropped, and not the events removed on purpose after the trim, before and after a restart", async () => {
    const path = join(dir, "trimmed-holes.jsonl");
    const { h } = await hub("trimmed-holes.jsonl");
    h.baseline(state([link("c1")]), new Map());
    for (let i = 0; i < 10_001; i++) h.emit("x", `x:${i}`);
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "a"), message("c1", "b")], deleted: [] });
    for (let i = 0; i < 9_998; i++) h.emit("x", `y:${i}`);
    // 20,001 events: the trim kept the last 10,000, from the first message on (10,002); then both are deleted.
    expect(h.replay(10_001)[0]).toMatchObject({ seq: 10_002, id: "message.received:c1:a" });
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["a", "b"] });
    const check = (hub: EventHub) => {
      expect(hub.replay(5)[0]).toMatchObject({ seq: 5, type: "events.gap", from: 6, to: 10_001 });
      expect(hub.replay(5)[1].seq).toBe(10_004);
      expect(hub.replay(10_000)[0]).toMatchObject({ type: "events.gap", from: 10_001, to: 10_001 });
      for (const since of [10_001, 10_002, 10_003]) expect(hub.replay(since)[0].seq).toBe(10_004);
    };
    check(h);
    h.release();
    const again = new EventHub(path, () => 1000, "trimmed-holes-again");
    await again.open();
    check(again);
  }, 60_000);

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

  it("opening learns the last seq and the line count without making the journal into text", async () => {
    const path = join(dir, "open.jsonl");
    const text = "é".repeat(1_000);
    writeFileSync(path, Array.from({ length: 1_000 }, (_, i) => JSON.stringify({ seq: i + 1, id: `x:${i + 1}`, type: "x", at: 1, text }) + "\n").join("") + '{"seq":1001,"id":"x:10');
    const decode = vi.spyOn(Buffer.prototype, "toString");
    const h = new EventHub(path, () => 1000, "open");
    await h.open();
    const longest = Math.max(0, ...decode.mock.results.map((r) => (typeof r.value === "string" ? r.value.length : 0)));
    decode.mockRestore();
    // A torn last line: cut off, and the seq it names (told to listeners before the cut) is not given again.
    expect(h.lastSeq).toBe(1_001);
    expect(longest).toBeLessThan(10_000);
    // A torn line with no seq: the last whole one's. It is cut off, and the trim counts what is left.
    const many = join(dir, "many.jsonl");
    writeFileSync(many, Array.from({ length: 20_001 }, (_, i) => JSON.stringify({ seq: i + 1, id: `x:${i + 1}`, type: "x", at: 1 }) + "\n").join("") + "torn");
    const full = new EventHub(many, () => 1000, "many");
    await full.open();
    expect(full.lastSeq).toBe(20_001);
    expect(readFileSync(many, "utf8").trim().split("\n")).toHaveLength(10_000);
  });

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

  it("a message deleted, a chat removed or a group left takes its texts out of the journal, and the journal set aside", async () => {
    const path = join(dir, "gone.jsonl");
    writeFileSync(path + ".unreadable", JSON.stringify({ seq: 1, type: "message.received", message: { text: "SECRET-OLD" } }));
    const { h } = await hub("gone.jsonl");
    const group = { id: "g1", status: "active", members: [{ key: "ana" }] };
    h.baseline(state([link("c1"), link("c2")], [group]), new Map());
    const journal = () => readFileSync(path, "utf8") + JSON.stringify(h.replay(0));
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "m1", { text: "SECRET-ONE" }), message("c1", "m2", { text: "kept" })], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "m1", { text: "SECRET-ONE, edited", edit: { seq: 1, at: 2 } } as never)], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "c2", messages: [message("c2", "m3", { text: "SECRET-TWO" })], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [message("group:g1", "m4", { text: "SECRET-THREE", member: "ana" })], deleted: [] });
    expect(journal()).toContain("SECRET-ONE");
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m1"] });
    expect(journal()).not.toContain("SECRET-ONE");
    expect(journal()).not.toContain("SECRET-OLD");
    expect(h.replay(0).map((e) => e.id)).toContain("message.deleted:c1:m1");
    expect(journal()).toContain("kept");
    h.sink.post({ kind: "state", state: state([link("c1")], [group]) });
    expect(journal()).not.toContain("SECRET-TWO");
    expect(h.replay(0).map((e) => e.id)).toContain("chat.removed:c2");
    h.sink.post({ kind: "state", state: state([link("c1")]) });
    expect(journal()).not.toContain("SECRET-THREE");
    expect(h.replay(0).map((e) => e.id)).toContain("group.removed:g1");
    expect(journal()).toContain("kept");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The seq goes on from where it was.
    expect(h.emit("x", "x:1").seq).toBe(h.replay(0).at(-2)!.seq + 1);
  });

  /**
   * A reply keeps its own events, but not the text of an original deleted since, here or for everyone by its author:
   * the journal says what history says ("Original message deleted"). Before, `listen --since` and `events` gave the
   * deleted text again inside each reply that quoted it, also as an agent turn's `untrusted.replyTo.snippet`.
   */
  it("a message deleted takes its text out of the replies that quoted it, in a chat and a group", async () => {
    const path = join(dir, "quoted.jsonl");
    const { h } = await hub("quoted.jsonl");
    h.baseline(state([link("c1")], [{ id: "g1", status: "active", members: [{ key: "ana" }] }]), new Map());
    const quote = (messageId: string, snippet: string) => ({ replyTo: { id: "wire-" + messageId, snippet, from: "me" as const, messageId } });
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "me_1", { sender: "me", text: "SECRET-QUOTED" }), message("c1", "p1", { text: "an answer", ...quote("me_1", "SECRET-QUOTED") }), message("c1", "p2", { text: "another", ...quote("me_2", "kept quote") })], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "p1", { text: "an answer, edited", edit: { seq: 1, at: 2 }, ...quote("me_1", "SECRET-QUOTED") } as never)], deleted: [] });
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [message("group:g1", "mine:1:0", { sender: "me", text: "SECRET-GROUP" }), message("group:g1", "ana:1:0", { member: "ana", text: "seen", ...quote("mine:1:0", "SECRET-GROUP") })], deleted: [] });
    const journal = () => readFileSync(path, "utf8") + JSON.stringify(h.replay(0));
    expect(journal()).toContain("SECRET-QUOTED");
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["me_1"] });
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [], deleted: ["mine:1:0"] });
    expect(journal()).not.toContain("SECRET-QUOTED");
    expect(journal()).not.toContain("SECRET-GROUP");
    // The replies stay, each saying its original is deleted, as history does; a quote of one still here is untouched.
    const replay = h.replay(0);
    const replyOf = (id: string) => replay.filter((e) => (e.message as { id?: string } | undefined)?.id === id).map((e) => [e.type, (e.message as { replyTo: unknown }).replyTo]);
    expect(replyOf("p1")).toEqual([
      ["message.received", { id: "me_1", snippet: "", from: "me", found: false, deleted: true }],
      ["message.edited", { id: "me_1", snippet: "", from: "me", found: false, deleted: true }],
    ]);
    expect(replyOf("ana:1:0")).toEqual([["group.message", { id: "mine:1:0", snippet: "", from: "me", found: false, deleted: true }]]);
    expect(replyOf("p2")).toEqual([["message.received", { id: "me_2", snippet: "kept quote", from: "me", found: true }]]);
    expect(toTurn(replay.find((e) => e.type === "message.received" && (e.message as { id: string }).id === "p1")!)!.untrusted.replyTo).toEqual({ id: "me_1", snippet: "" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /**
   * A deletion is synchronous work on the daemon's one thread: each read the whole journal as text and tried every id
   * on every line (25 ms a message at 10,000 events, 12 s for 2,000 ids in one change), a contact's delete for everyone
   * included. Counted here as the journal's bytes made into text, and as the time of one long change.
   */
  describe("what a deletion reads of the journal", () => {
    const text = "x".repeat(300);
    async function filled(journal: string, count: number) {
      const { h } = await hub(journal);
      h.baseline(state([link("c1")]), new Map());
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: Array.from({ length: count }, (_, i) => message("c1", `m${i}`, { text: `${text} ${i}` })), deleted: [] });
      return { h, path: join(dir, journal) };
    }
    function decoded(work: () => void): number {
      const toString = Buffer.prototype.toString;
      let bytes = 0;
      const spy = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args: unknown[]) {
        const [, start = 0, end = this.length] = args as [string?, number?, number?];
        bytes += Math.max(0, Math.min(end, this.length) - start);
        return toString.apply(this, args as never);
      });
      try { work(); } finally { spy.mockRestore(); }
      return bytes;
    }

    it("a recent message reads the journal from its events on; one the journal no longer names reads none as text", async () => {
      const { h, path } = await filled("reads.jsonl", 2_000);
      const size = statSync(path).size;
      expect(decoded(() => h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m1999"] }))).toBeLessThan(size / 50);
      expect(readFileSync(path, "utf8")).not.toContain(`${text} 1999"`);
      expect(readFileSync(path, "utf8")).toContain(`${text} 1998"`);
      // Known here, its events gone from the journal (trimmed, as a long one is): only its deletion's own line is read
      // as text, and nothing is written but that line.
      writeFileSync(path, readFileSync(path, "utf8").split("\n").filter((line) => !line.includes('"m5"')).join("\n"));
      const before = readFileSync(path, "utf8");
      expect(decoded(() => h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m5"] }))).toBeLessThan(200);
      expect(readFileSync(path, "utf8").slice(before.length)).toMatch(/^\{[^\n]*"message\.deleted:c1:m5"[^\n]*\}\n$/);
      // What the journal holds still holds: it replays, and goes on.
      expect(h.replay(0).filter((e) => e.type === "message.received")).toHaveLength(1_998);
      expect(h.replay(0).map((e) => e.id)).toContain("message.deleted:c1:m1999");
      expect(h.emit("x", "x:2").seq).toBe(h.replay(0).at(-2)!.seq + 1);
    });

    /**
     * An old message deleted wrote the whole journal again from its first event on, made into text (16 MiB and 70 ms a
     * deletion at 10,000 events): now only its lines are read as text and written over where they are.
     */
    it("an old message deleted writes over its own lines only, and the journal still opens and replays", async () => {
      const { h, path } = await filled("in-place.jsonl", 2_000);
      const quote = { replyTo: { id: "wire-m5", snippet: `${text} 5`, from: "peer" as const, messageId: "m5" } };
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "r1", { text: "an answer", ...quote })], deleted: [] });
      const before = readFileSync(path), file = statSync(path).ino;
      expect(decoded(() => h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m5"] }))).toBeLessThan(before.length / 50);
      const after = readFileSync(path);
      // The same file, where only the message's own line and the reply that quoted it changed; then the deletion's line.
      expect(statSync(path).ino).toBe(file);
      const lines = (bytes: Buffer) => bytes.toString("utf8").split("\n");
      const was = lines(before), now = lines(after.subarray(0, before.length));
      expect(now).toHaveLength(was.length);
      expect(was.filter((line, i) => line !== now[i]).map((line) => (JSON.parse(line) as GhostlyEvent).id)).toEqual(["message.received:c1:m5", "message.received:c1:r1"]);
      expect(after.toString("utf8")).not.toContain(`${text} 5"`);
      const check = (hub: EventHub) => {
        const replayed = hub.replay(0);
        expect(replayed.filter((e) => e.type === "message.received")).toHaveLength(2_000);
        expect(replayed.map((e) => e.id)).not.toContain("message.received:c1:m5");
        expect(replayed.find((e) => e.id === "message.received:c1:r1")!.message).toMatchObject({ replyTo: { id: "m5", snippet: "", found: false, deleted: true } });
        expect(replayed.at(-1)!.id).toBe("message.deleted:c1:m5");
      };
      check(h);
      h.release();
      const again = new EventHub(path, () => 1000, "in-place-again");
      await again.open();
      expect(again.lastSeq).toBe(h.lastSeq);
      check(again);
    });

    function allocated(work: () => void): number {
      const alloc = Buffer.alloc;
      let bytes = 0;
      const spy = vi.spyOn(Buffer, "alloc").mockImplementation((size: number, ...rest: unknown[]) => { bytes += size; return alloc.call(Buffer, size, ...(rest as [])); });
      try { work(); } finally { spy.mockRestore(); }
      return bytes;
    }

    /**
     * Each deletion read the journal's whole window from disk (up to 32 MiB) and searched it, a contact's delete for
     * everyone included: 50 of them cost a daemon with a long journal 1.5 GiB of reads. Now a deletion reads from the
     * first line that names the message on.
     */
    it("a contact deleting recent messages one by one reads the journal from their events on, not whole each time", async () => {
      const { h, path } = await filled("recent.jsonl", 2_000);
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m1989"] });
      const size = statSync(path).size;
      const read = allocated(() => {
        for (let i = 1990; i < 2_000; i++) h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: [`m${i}`] });
      });
      expect(read).toBeLessThan(size / 10);
      const journal = readFileSync(path, "utf8");
      for (let i = 1989; i < 2_000; i++) expect(journal).not.toContain(`${text} ${i}"`);
      expect(journal).toContain(`${text} 1988"`);
      expect(h.replay(0).filter((e) => e.type === "message.received")).toHaveLength(1_989);
    });

    it("still finds a message's lines after the journal was written again, appended to and trimmed", async () => {
      const { h, path } = await filled("rewritten.jsonl", 600);
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m0"] });
      // Many ids at once: the journal is written again, every line after them moved.
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: Array.from({ length: 100 }, (_, i) => `m${i + 1}`) });
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "late", { text: "SECRET-LATE", replyTo: { id: "wire-m300", snippet: "SECRET-QUOTE", from: "peer", messageId: "m300" } })], deleted: [] });
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m300"] });
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["late"] });
      const journal = readFileSync(path, "utf8");
      expect(journal).not.toContain(`${text} 300"`);
      expect(journal).not.toContain("SECRET-LATE");
      expect(journal).not.toContain("SECRET-QUOTE");
      // A trim moves every line too.
      for (let i = 0; i < 20_001; i++) h.emit("x", `x:${i}`);
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [message("c1", "after", { text: "SECRET-AFTER" })], deleted: [] });
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["after"] });
      expect(readFileSync(path, "utf8")).not.toContain("SECRET-AFTER");
    }, 60_000);

    it("a line cut short inside the journal that names a deleted message still goes", async () => {
      const path = join(dir, "cut.jsonl");
      const line = (seq: number, id: string, text: string) => JSON.stringify({ seq, id: `message.received:c1:${id}`, type: "message.received", at: 1, chat: "c1", message: { id, text } });
      writeFileSync(path, [line(1, "m1", "kept one"), line(2, "m2", "SECRET-CUT").slice(0, 80), line(3, "m3", "kept two")].join("\n") + "\n");
      const { h } = await hub("cut.jsonl");
      h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "m1"), message("c1", "m2"), message("c1", "m3")]]]));
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ["m2"] });
      const journal = readFileSync(path, "utf8");
      expect(journal).not.toContain("SECRET-CUT");
      expect(journal).toContain("kept one");
      expect(journal).toContain("kept two");
    });

    it("a change that deletes thousands of messages reads each line once", async () => {
      const { h, path } = await filled("many.jsonl", 5_000);
      const ids = Array.from({ length: 4_000 }, (_, i) => `m${i}`);
      const start = performance.now();
      h.sink.post({ kind: "message-changes", linkId: "c1", messages: [], deleted: ids });
      expect(performance.now() - start).toBeLessThan(1_500);
      const left = h.replay(0).filter((e) => e.type === "message.received").map((e) => (e.message as { id: string }).id);
      expect(left).toEqual(Array.from({ length: 1_000 }, (_, i) => `m${4_000 + i}`));
      expect(readFileSync(path, "utf8")).not.toContain(`${text} 3999"`);
    }, 60_000);
  });

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

    /**
     * A transfer that ends while its daemon stops, or as the next start runs before the hub reads the engine: the next
     * start reports its end, once. It said nothing: a bot that restarted while a big file came never handled the file.
     */
    describe("a transfer that ends while no hub watches", () => {
      const sent = message("c1", "me_8", { sender: "me", delivery: "sent", file: { id: "c1-out-w", name: "a", size: 9, mime: "text/plain" } });
      const history = () => new Map([["c1", [message("c1", "peer_v", { file: voice }), sent]]]);
      async function underWay(journal: string) {
        const first = await hub(journal);
        first.h.baseline(state([link("c1")]), history());
        first.h.sink.post({ kind: "state", state: transfers({
          "c1-in-v": { state: "transferring", transferred: 400, size: 900, direction: "in", stage: "verifying" },
          "c1-out-w": { state: "transferring", transferred: 0, size: 9, direction: "out", stage: "asking" },
        }) });
        expect(first.events.map((e) => [e.type, e.file])).toEqual([["file.stage", "c1-in-v"], ["file.stage", "c1-out-w"]]);
        // The seen set is written behind: the next start reads it once it is in.
        await new Promise((r) => setTimeout(r, 50));
      }

      it("ended while it stopped: the next start reads its end in the file's record", async () => {
        await underWay("ended-stop.jsonl");
        const { h, events } = await hub("ended-stop.jsonl");
        // A finished file has no transfer in the engine's state at start: only its record says it is done.
        h.baseline(state([link("c1")]), history());
        const records: Record<string, unknown> = {
          "c1-in-v": { direction: "in", transfer: { state: "done", transferred: 900, size: 900 } },
          "c1-out-w": { direction: "out", transfer: { state: "failed", transferred: 0, size: 9, error: "Declined" } },
        };
        await h.ended(async (id) => records[id] as never);
        expect(events.map((e) => [e.type, e.file, e.chat, e.messageId, e.direction])).toEqual([
          ["file.done", "c1-in-v", "c1", "peer_v", "in"],
          ["file.failed", "c1-out-w", "c1", "me_8", "out"],
        ]);
        expect(events[0]).toMatchObject({ id: "file.done:c1-in-v", size: 900, transferred: 900 });
        expect(events[1]).toMatchObject({ error: "Declined" });
        // Told once: a start after it says nothing again.
        await new Promise((r) => setTimeout(r, 50));
        const again = await hub("ended-stop.jsonl");
        again.h.baseline(state([link("c1")]), history());
        await again.h.ended(async (id) => records[id] as never);
        expect(again.events).toEqual([]);
      });

      it("ended as the next start ran: the start's state has it done", async () => {
        await underWay("ended-start.jsonl");
        const { h, events } = await hub("ended-start.jsonl");
        h.baseline(transfers({ "c1-in-v": { state: "done", transferred: 900, size: 900, direction: "in" }, "c1-out-w": { state: "transferring", transferred: 0, size: 9, direction: "out", stage: "asking" } }), history());
        expect(events.map((e) => [e.type, e.file, e.messageId])).toEqual([["file.done", "c1-in-v", "peer_v"]]);
        await h.ended(async () => undefined);
        expect(events).toHaveLength(1);
        // Still under way, the other one is reported when it ends.
        h.sink.post({ kind: "state", state: transfers({ "c1-in-v": { state: "done", transferred: 900, size: 900, direction: "in" }, "c1-out-w": { state: "done", transferred: 9, size: 9, direction: "out" } }) });
        expect(events.map((e) => [e.type, e.file])).toEqual([["file.done", "c1-in-v"], ["file.done", "c1-out-w"]]);
      });

      it("one never seen under way, or whose record is gone, says nothing", async () => {
        await underWay("ended-none.jsonl");
        const { h, events } = await hub("ended-none.jsonl");
        h.baseline(transfers({ "c1-in-x": { state: "done", transferred: 9, size: 9, direction: "in" } }), history());
        await h.ended(async () => undefined);
        expect(events).toEqual([]);
        await new Promise((r) => setTimeout(r, 50));
        // The notes of files whose records went are dropped: a record that comes back later is no news either.
        const again = await hub("ended-none.jsonl");
        again.h.baseline(state([link("c1")]), history());
        await again.h.ended(async () => ({ direction: "in", transfer: { state: "done", transferred: 900, size: 900 } }) as never);
        expect(again.events).toEqual([]);
      });

      /**
       * v1.10.1 reading a seen set with the `files:` notes (a downgrade): its whole read and its `sweep` are copied below
       * from `git show v1.10.1:packages/cli/src/events.ts` (open, lines 144-154; sweep, 197-214; stateIn/timeIn/settled/
       * splitState, 773-813). Nothing else there reads the set but by a chat's, group's, `reactions:` or `said:` key, and
       * `files:` is none (as `format:`). A note `yes` has no `@time`: its sweep keeps it, and drops the others as ever.
       */
      it("v1.10.1 keeps the under-way notes, reports nothing of them, and sweeps the others as ever", async () => {
        await underWay("ended-v1101.jsonl");
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("ended-v1101.jsonl", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const persist = (chat: string, changes: [string, string | null][]) => new Promise<void>((resolve, reject) => {
          const tx = db.transaction("seen", "readwrite");
          for (const [id, note] of changes) {
            if (note === null) tx.objectStore("seen").delete([chat, id]);
            else tx.objectStore("seen").put(note, [chat, id]);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        const read = async () => {
          const store = db.transaction("seen").objectStore("seen");
          const all = <T>(request: IDBRequest<T[]>) => new Promise<T[]>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const [keys, values] = await Promise.all([all(store.getAllKeys()), all(store.getAll() as IDBRequest<string[]>)]);
          const seen = new Map<string, Map<string, string>>();
          for (let i = 0; i < keys.length; i++) {
            const [chat, id] = keys[i] as [string, string];
            if (!seen.has(chat)) seen.set(chat, new Map());
            seen.get(chat)!.set(id, values[i]);
          }
          return seen;
        };
        const seen = await read();
        expect([...seen.get("files:")!.entries()]).toEqual([["c1-in-v", "yes"], ["c1-out-w", "yes"]]);

        // v1.10.1's sweep, as it is there, a month past every note's time.
        const now = 1000 + SEEN_KEEP_MS + 1;
        const stateIn = (note: string) => { const at = note.lastIndexOf("@"); return at === -1 ? note : note.slice(0, at); };
        const timeIn = (note: string) => { const at = note.lastIndexOf("@"); return at === -1 ? undefined : parseInt(note.slice(at + 1), 36); };
        const splitState = (state: string): [string, number] => { const at = state.lastIndexOf("#e"); return at === -1 ? [state, 0] : [state.slice(0, at), Number(state.slice(at + 2)) || 0]; };
        const settled = (state: string) => { const delivery = splitState(state)[0].split("+")[0]; return delivery === "received" || delivery === "delivered"; };
        const writes: Promise<void>[] = [];
        const sweep = () => {
          const cutoff = now - SEEN_KEEP_MS;
          let dropped = 0;
          for (const [chat, known] of seen) {
            if (chat === "format:" || chat.startsWith("said:")) continue;
            const reactions = chat.startsWith("reactions:");
            const gone: [string, null][] = [];
            for (const [id, note] of known) {
              const at = timeIn(note);
              if (at === undefined || at >= cutoff || (!reactions && !settled(stateIn(note)))) continue;
              known.delete(id);
              gone.push([id, null]);
            }
            if (gone.length) { writes.push(persist(chat, gone)); dropped += gone.length; }
            if (!known.size) seen.delete(chat);
          }
          return dropped;
        };
        // The message received a month ago goes; mine still `sent` stays; the under-way notes stay, in memory and stored.
        expect(sweep()).toBe(1);
        await Promise.all(writes);
        const after = await read();
        db.close();
        for (const kept of [seen, after]) {
          expect([...kept.get("files:")!.entries()]).toEqual([["c1-in-v", "yes"], ["c1-out-w", "yes"]]);
          expect([...kept.get("c1")!.keys()]).toEqual(["me_8"]);
          expect(kept.get("format:")!.get("ages")).toBe("yes");
        }

        // Back on this version, the ends are still told from the files' records (its clock is not a month on: the swept
        // message is news to it, which is not what this pins).
        const { h, events } = await hub("ended-v1101.jsonl");
        h.baseline(state([link("c1")]), history());
        await h.ended(async (id) => ({ direction: id.includes("-in-") ? "in" : "out", transfer: { state: "done", transferred: 9, size: 9 } }) as never);
        expect(events.filter((e) => e.type.startsWith("file.")).map((e) => [e.type, e.file])).toEqual([["file.done", "c1-in-v"], ["file.done", "c1-out-w"]]);
      });
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
    h.baseline(state([link("c1"), link("c2")]), new Map([["c1", [m1, me1, me2, m3]], ["c2", []]]));
    h.markSaid("c1", "joined");

    clock.now = 41 * DAY;
    // Another contact wrote yesterday: the 30 days count back from the clock, which is no later than the newest activity.
    h.sink.post({ kind: "messages", linkId: "c2", messages: [message("c2", "n40", { timestamp: 40 * DAY })] });
    events.length = 0;
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
  it("an edit dated a month back by its author's clock, of a message whose note was dropped, is news: it came here now", async () => {
    const m1 = message("c1", "m1", { timestamp: 10 * DAY }), m2 = message("c1", "m2", { timestamp: 10 * DAY });
    clock.now = 10 * DAY;
    const { h, events } = await clocked("late-edit.jsonl");
    h.baseline(state([link("c1")]), new Map([["c1", [m1, m2]]]));
    clock.now = 50 * DAY;
    // A message today, so the sweep's window (counted back from the newest activity) lets m1 and m2's notes go.
    const m50 = message("c1", "m50", { timestamp: 50 * DAY });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [m1, m2, m50] });
    expect(h.sweep()).toBe(2);
    events.length = 0;
    // The contact's clock says day 19 (31 days behind): the engine keeps that as the edit's time, and when it took it.
    const edited = { ...m1, text: "v1", edit: { seq: 1, at: 19 * DAY, heardAt: 50 * DAY, history: [{ at: 10 * DAY, text: "t m1" }] } };
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [edited], deleted: [] });
    expect(events.map((e) => e.id)).toEqual(["message.edited:c1:m1:1"]);
    // A reaction (this side's clock) on the other one is reported as ever, with no edit.
    const m2r = { ...m2, reactions: { peer: { e: "👍", n: 1, at: 50 * DAY } } };
    h.sink.post({ kind: "message-changes", linkId: "c1", messages: [m2r], deleted: [] });
    expect(events.map((e) => e.id).slice(1)).toEqual(["message.reaction:c1:m2:peer:1"]);
    // An edit stored before the engine kept when it came, dated a month back: no news, as before.
    const old = message("c1", "m3", { timestamp: 10 * DAY, text: "v1", edit: { seq: 1, at: 19 * DAY, history: [] } });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [edited, m2r, old, m50] });
    expect(events).toHaveLength(2);

    // A restart: nothing again, now or after a sweep 40 days on; the newest rows are in step.
    await new Promise((r) => setTimeout(r, 50));
    clock.now = 51 * DAY;
    const again = await clocked("late-edit.jsonl");
    again.h.baseline(state([link("c1")]), new Map([["c1", [edited, m2r, old, m50]]]));
    clock.now = 90 * DAY;
    again.h.sweep();
    again.h.sink.post({ kind: "messages", linkId: "c1", messages: [edited, m2r, old, m50] });
    expect(again.events).toEqual([]);
    expect(again.h.inStep("c1", [edited, m2r, old, m50])).toBe(true);
  });

  it("a group's line read more than 30 days after its commit is news: it came here now; a restart says it no more", async () => {
    const g1 = { id: "g1", name: "G", members: [], isAdmin: false, canSend: true, lastMessageAt: 0, profile: "mesh", invited: [], memberLinks: {}, createdAt: 1 };
    const said = message("group:g1", "bo:1:0", { member: "bo", timestamp: 5 * DAY });
    clock.now = 10 * DAY;
    const { h, events } = await clocked("late-line.jsonl");
    h.baseline(state([], [g1]), new Map([["group:g1", [said]]]));
    // Back on day 50: the line "Ana joined" committed on day 15 keeps that moment as its place, and a new message.
    clock.now = 50 * DAY;
    h.sweep();
    const joined = message("group:g1", `event:2:joined:${15 * DAY}`, { event: "joined", text: "Ana joined", member: "anakey", timestamp: 15 * DAY, heardAt: 50 * DAY });
    const hello = message("group:g1", "anakey:2:0", { member: "anakey", timestamp: 50 * DAY });
    h.sink.post({ kind: "message-changes", linkId: "group:g1", messages: [joined, hello], deleted: [] });
    expect(events.map((e) => e.id)).toEqual([`group.event:g1:${joined.id}`, "group.message:g1:anakey:2:0"]);
    // A line stored before the engine kept when it came, a month old: no news, as before.
    const older = message("group:g1", `event:1:joined:${12 * DAY}`, { event: "joined", text: "Bo joined", member: "bo", timestamp: 12 * DAY });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [said, older, joined, hello] });
    expect(events).toHaveLength(2);

    // A restart, the next day and once its notes are gone: nothing again.
    await new Promise((r) => setTimeout(r, 50));
    clock.now = 51 * DAY;
    const again = await clocked("late-line.jsonl");
    expect(again.h.inStep("group:g1", [joined, hello])).toBe(true);
    again.h.baseline(state([], [g1]), new Map([["group:g1", [said, older, joined, hello]]]));
    clock.now = 90 * DAY;
    again.h.sweep();
    again.h.sink.post({ kind: "messages", linkId: "group:g1", messages: [said, older, joined, hello] });
    expect(again.events).toEqual([]);
  });

  it("with no activity in the last 30 days, a sweep keeps the newest 30 days of notes: the clock is no proof that they passed", async () => {
    clock.now = 10 * DAY;
    const { h } = await clocked("idle.jsonl");
    h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "m1", { timestamp: 1 * DAY }), message("c1", "m9", { timestamp: 9 * DAY })]]]));
    clock.now = 100 * DAY;
    expect(h.sweep()).toBe(0);
    // A message today: the window counts back from it, and m1 (and m9, 91 days before it) go.
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "m1", { timestamp: 1 * DAY }), message("c1", "m9", { timestamp: 9 * DAY }), message("c1", "m100", { timestamp: 100 * DAY })] });
    expect(h.sweep()).toBe(2);
    expect([...notes(h).get("c1")!.keys()]).toEqual(["m100"]);
  });

  it("a start with the clock more than 30 days ahead drops no recent note: the next start, the clock right again, reports nothing again", async () => {
    clock.now = 80 * DAY;
    const first = await clocked("skew.jsonl");
    first.h.baseline(state([link("c1")]), new Map([["c1", []]]));
    const m80 = message("c1", "m80", { timestamp: 80 * DAY });
    const m90 = message("c1", "m90", { timestamp: 90 * DAY, reactions: { peer: { e: "👍", n: 1, at: 95 * DAY } } });
    const me99 = message("c1", "me99", { sender: "me", delivery: "delivered", timestamp: 99 * DAY });
    first.h.sink.post({ kind: "messages", linkId: "c1", messages: [m80, m90, me99] });
    expect(first.events.map((e) => e.id).sort()).toEqual(["message.reaction:c1:m90:peer:1", "message.received:c1:m80", "message.received:c1:m90", "message.sent:c1:me99"]);
    await new Promise((r) => setTimeout(r, 50));

    // A wrong clock at one start: 60 days ahead.
    clock.now = 160 * DAY;
    const skewed = await clocked("skew.jsonl");
    skewed.h.baseline(state([link("c1")]), new Map([["c1", [m80, m90, me99]]]));
    expect(skewed.events).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));

    clock.now = 100 * DAY;
    const right = await clocked("skew.jsonl");
    right.h.baseline(state([link("c1")]), new Map([["c1", [m80, m90, me99]]]));
    expect(right.events).toEqual([]);
  });
});
