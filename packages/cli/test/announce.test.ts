import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { GhostlyNode } from "@ghostly/browser/engine/node";
import { announceJoins } from "../src/announce";
import { EventHub } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events

/**
 * The join notice reads the engine's state only for the events that may say it. Every message, typing event and app
 * frame names a chat too, and each built the whole state first: 3 ms an event with 300 chats, up to ~48 frames a second.
 */
it("reads the engine's state only for an event that may announce a join", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-announce-"));
  await openPersistentIndexedDb(join(dir, "db"));
  const hub = new EventHub(join(dir, "events.jsonl"), () => 1000, "announce");
  await hub.open();
  let reads = 0;
  const sent: string[] = [];
  const state = { settings: { nick: "Bot" }, links: [{ id: "c1", profile: { name: "Ana" }, pairingProgress: { role: "inviter" } }] };
  const node = {
    getState: () => { reads++; return state; },
    sendMessage: async ({ text }: { text: string }) => { sent.push(text); },
  } as unknown as GhostlyNode;
  announceJoins(hub, node);

  hub.emitLive("app.message", "app.message:1", { chat: "c1", app: "x", data: 1 });
  hub.emit("typing.started", "typing.started:1", { chat: "c1" });
  hub.emit("message.received", "message.received:1", { chat: "c1", message: { id: "m1" } });
  hub.emit("chat.connection", "chat.connection:1", { chat: "c1", live: false });
  expect(reads).toBe(0);

  hub.emit("chat.joined", "chat.joined:1", { chat: "c1" });
  await Promise.resolve();
  expect(sent).toEqual(["👋 Bot joined"]);
  // Said once: a later join reads nothing.
  reads = 0;
  hub.emit("chat.joined", "chat.joined:2", { chat: "c1" });
  expect(reads).toBe(0);
  expect(sent).toHaveLength(1);
});
