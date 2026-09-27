import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events, headless.typing

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
    h.sink.post({ kind: "call-signal", linkId: "c2", signal: JSON.stringify({ t: "o" }) });
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
      [10, "call.offer:c2:1000"],
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
    expect(events.map((e) => [e.type, e.id, e.chat])).toEqual([
      ["typing.started", "typing.started:c1:1000", "c1"],
      ["typing.stopped", "typing.stopped:c1:1000", "c1"],
    ]);
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
});
