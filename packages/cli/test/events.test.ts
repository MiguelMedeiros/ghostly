import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { EventHub, type GhostlyEvent } from "../src/events";
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
  it("reports messages, delivery changes, deletions, and chat changes once each", async () => {
    const { h, events } = await hub("a.jsonl");
    h.baseline(state([link("c1")]), new Map([["c1", [message("c1", "old")]]]));
    expect(events).toEqual([]);
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "old"), message("c1", "new"), message("c1", "me_1", { sender: "me", delivery: "sending" })] });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "old"), message("c1", "new"), message("c1", "me_1", { sender: "me", delivery: "delivered" })] });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [message("c1", "new"), message("c1", "me_1", { sender: "me", delivery: "delivered" })] });
    h.sink.post({ kind: "state", state: state([link("c1", { textDelivery: "stream", pairing: { status: "ready", transport: "hyperdht/1" }, pairingProgress: { stage: "live" } as never }), link("c2")]) });
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

  it("reports group messages, mentions included", async () => {
    const { h, events } = await hub("c.jsonl");
    h.baseline(state([], [{ id: "g1", name: "G", members: [], isAdmin: false, canSend: true, lastMessageAt: 0, profile: "community", invited: [], memberLinks: {}, createdAt: 1 }]), new Map([["group:g1", []]]));
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [message("group:g1", "x", { member: "k1", mentioned: true, mentions: [{ k: "me", o: 0, l: 3 }] }), message("group:g1", "j", { event: "joined" })] });
    expect(events.map((e) => e.id)).toEqual(["group.message:g1:x", "group.event:g1:j"]);
    expect(events[0]).toMatchObject({ group: "g1", message: { member: "k1", mentioned: true, mentions: [{ key: "me", offset: 0, length: 3 }] } });
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
