import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createIdentity } from "@ghostly/core";
import type { StoredLink, StoredMessage } from "@ghostly/browser/shared/types";
import { ghostly, home, ok } from "./support/cli";
import { profilePaths } from "../src/profiles";
// covers: chat.saved, headless.one-shot

/**
 * A one-shot `saved list` leaves the saved chats unstarted (`readsNoHistory`): it read every 1:1 chat's whole history
 * at start, +0.5 s per 30,000 messages in the profile, for an answer that needs none of it. The answer is the same:
 * each saved row as it is now, the contact's name, and a saved reply's quote checked against its original.
 */
const chat = (id: string, label: string, peerNick?: string) => ({ id, profile: "paired-chat/1", createdAt: 1, label, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 }, ...(peerNick !== undefined && { peerNick }) }) as StoredLink;
const row = (linkId: string, id: string, timestamp: number, fields: Partial<StoredMessage> = {}): StoredMessage => ({
  linkId, id, text: `text of ${id}`, sender: id.startsWith("me_") ? "me" : "peer", timestamp, via: "datalink", ...fields,
});
const reply = (to: string, snippet: string) => ({ replyTo: { id: `wire-${to}`, snippet, from: "peer" as const, messageId: to } });

describe("one-shot saved list", { timeout: 120_000 }, () => {
  const dir = home("saved-list");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("answers the saved rows, the contact's name and each quote as with every chat started", async () => {
    ok(await ghostly(["--home", dir, "status"]));
    const { openPersistentIndexedDb } = await import("../src/runtime/storage");
    const store = await openPersistentIndexedDb(profilePaths(dir, "default").db);
    const { db } = await import("@ghostly/browser/engine/db");
    await db.putLink(chat("chat-alice", "Alice", "Alice Liddell"));
    await db.putLink(chat("chat-bob", "Bob"));
    for (const m of [
      row("chat-alice", "peer_orig", 1, { text: "the original" }),
      row("chat-alice", "me_reply", 2, reply("peer_orig", "the original")),
      row("chat-alice", "me_lost", 3, reply("peer_gone", "taken back")),
      row("chat-alice", "peer_edited", 4, { text: "now reads this", edit: { seq: 1, at: 5 } } as Partial<StoredMessage>),
      row("chat-alice", "me_on_edit", 6, reply("peer_edited", "first words")),
      ...Array.from({ length: 50 }, (_, i) => row("chat-bob", `peer_b${i}`, 10 + i)),
    ]) await db.putMessage(m);
    await store.close();

    for (const [ref, id] of [["Alice", "peer_orig"], ["Alice", "me_reply"], ["Alice", "me_lost"], ["Alice", "me_on_edit"], ["Bob", "peer_b7"]]) {
      ok(await ghostly(["--home", dir, "saved", "add", ref, id]));
    }
    const { saved } = ok(await ghostly(["--home", dir, "saved", "list"])) as {
      saved: { chat: string; message: { id: string; text: string; nick?: string; replyTo?: { snippet: string; found: boolean; deleted?: boolean } } }[];
    };
    const byId = new Map(saved.map((s) => [s.message.id, s]));
    expect(saved.map((s) => s.message.id)).toEqual(["peer_b7", "me_on_edit", "me_lost", "me_reply", "peer_orig"]);
    expect(byId.get("peer_orig")).toMatchObject({ chat: "chat-alice", message: { text: "the original", nick: "Alice Liddell" } });
    expect(byId.get("peer_b7")).toMatchObject({ chat: "chat-bob", message: { text: "text of peer_b7" } });
    expect(byId.get("me_reply")!.message.replyTo).toMatchObject({ snippet: "the original", found: true });
    expect(byId.get("me_lost")!.message.replyTo).toMatchObject({ snippet: "", found: false, deleted: true });
    expect(byId.get("me_on_edit")!.message.replyTo).toMatchObject({ snippet: "now reads this", found: true });
  });
});
