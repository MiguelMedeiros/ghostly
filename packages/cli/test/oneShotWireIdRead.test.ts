import { describe, expect, it } from "vitest";
import type { LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import type { ApiContext } from "../src/api";
import { startNamedChats } from "../src/apiKit";
// covers: headless.one-shot

const CHAT = "chatCarol";
const MINE = "Aaaaaaaaaaaaaaaaaaaaa1", THEIRS = "Bbbbbbbbbbbbbbbbbbbbb2", FILE = "Ccccccccccccccccccccc3";
const rows: StoredMessage[] = [
  { linkId: CHAT, id: `me_${MINE}`, wireId: MINE, text: "mine", sender: "me", timestamp: 1, via: "datalink" },
  { linkId: CHAT, id: `peer_${THEIRS}`, text: "theirs", sender: "peer", timestamp: 2, via: "datalink" },
  // A file of mine is kept under its time: only the history says its wire id.
  { linkId: CHAT, id: "me_3", text: "a.txt", sender: "me", timestamp: 3, via: "datalink",
    file: { id: `${CHAT}-out-${FILE}`, name: "a.txt", size: 1, mime: "text/plain" } },
] as unknown as StoredMessage[];

/** A one-shot's engine with Carol's chat unstarted: what `startNamedChats` read whole, started and only read. */
function oneShot() {
  const seen = { wholeReads: 0, started: [] as string[], readOnly: [] as string[] };
  const node = {
    getState: () => ({ links: [{ id: CHAT, peerPubKeyZ32: "pcarol", peerNick: "carol", createdAt: 1, lastMessageAt: 0 } as unknown as LinkView], groups: [] }),
    getMessage: async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id),
    getMessages: async (linkId: string) => { seen.wholeReads++; return rows.filter((m) => m.linkId === linkId); },
    startDeferredChat: async (linkId: string) => { seen.started.push(linkId); },
    readDeferredChat: async (linkId: string) => { seen.readOnly.push(linkId); },
    startDeferredGroup: () => {},
  };
  return { ctx: { runtime: { server: { node } } } as unknown as ApiContext, seen };
}

/**
 * A one-shot on a message named by its wire id (the id both sides know, which the README offers for `<message>`)
 * starts its chat without reading the chat's history whole first, as one naming the row's id does: the start reads it
 * anyway. It read it whole here too, then again as the chat started: 0.45 s more a call at 100,000 messages. Only a ref
 * no row is kept under (a file of mine, a mistyped id) is looked for in the whole history, and a mistyped one still
 * starts nothing.
 */
describe("a one-shot on a message named by its wire id", () => {
  it("starts the chat with no whole read of its history, for a text of mine and one of theirs", async () => {
    for (const method of ["chat.react", "chat.pin", "chat.edit", "chat.delete", "chat.retry"]) {
      for (const message of [MINE, THEIRS, `me_${MINE}`, `peer_${THEIRS}`]) {
        const { ctx, seen } = oneShot();
        await startNamedChats(ctx, method, { chat: "carol", message, emoji: "👍" });
        expect(seen, `${method} ${message}`).toEqual({ wholeReads: 0, started: [CHAT], readOnly: [] });
      }
    }
  });

  it("finds a message only the history names by its wire id, and refuses a mistyped one without starting the chat", async () => {
    const file = oneShot();
    await startNamedChats(file.ctx, "chat.react", { chat: "carol", message: FILE, emoji: "👍" });
    expect(file.seen).toEqual({ wholeReads: 1, started: [CHAT], readOnly: [] });
    const mistyped = oneShot();
    await startNamedChats(mistyped.ctx, "chat.react", { chat: "carol", message: "nosuch", emoji: "👍" });
    expect(mistyped.seen).toEqual({ wholeReads: 1, started: [], readOnly: [CHAT] });
  });
});
