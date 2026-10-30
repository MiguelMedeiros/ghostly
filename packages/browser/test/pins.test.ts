import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { myPin, pinnedRow, type PinsHost } from "../src/engine/pins";
import { fileStore } from "../src/shared/idb";
import type { StoredMessage, StoredPin } from "../src/shared/types";
// covers: chat.pins.wire

/**
 * The row a pin names in a long chat (WISP 400 § Pinned message): found by its key, a text's or a file of mine's, so a
 * pin costs the same however long the chat; the whole chat is read only for a row its keys do not find.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const wire = (i: number) => `${"W".repeat(20)}${String(i).padStart(2, "0")}`, fileWire = "F".repeat(22), at = 1_700_000_001_000;
const chatRows = (linkId: string): StoredMessage[] => [
  ...Array.from({ length: 50 }, (_, i): StoredMessage => ({ linkId, id: `me_${wire(i)}`, wireId: wire(i), text: `line ${i}`, sender: "me", timestamp: 1_700_000_000_000 + i, via: "datalink" })),
  { linkId, id: `me_${at}`, text: "📎 photo.jpg", sender: "me", timestamp: at, via: "datalink", file: { id: `${linkId}-out-${fileWire}`, name: "photo.jpg", size: 5, mime: "image/jpeg" } },
];

describe("my pin", () => {
  // A chat's rows by key, the whole chat counted, and my file's row by its time (as the engine's stored file says).
  const host = (linkId: string) => {
    const rows = chatRows(linkId), whole = vi.fn(async () => rows);
    const pins: PinsHost = { messages: whole, message: async (_, id) => rows.find(m => m.id === id), rows: async (_, id) => id === fileWire ? [`me_${at}`] : [] };
    return { pins, whole };
  };

  it("finds a text of mine by the id both sides know it by, or by its row, without reading the whole chat", async () => {
    const linkId = `pins-${crypto.randomUUID()}`, t = host(linkId);
    expect(await myPin(t.pins, linkId, wire(7), false, undefined, 5)).toMatchObject({ id: wire(7), by: "me", at: 5, messageId: `me_${wire(7)}` });
    expect(await myPin(t.pins, linkId, `me_${wire(8)}`, false, undefined, 5)).toMatchObject({ id: wire(8), messageId: `me_${wire(8)}` });
    expect(t.whole).not.toHaveBeenCalled();
  });

  it("finds a file of mine by its wire id or its row, without reading the whole chat", async () => {
    const linkId = `pins-${crypto.randomUUID()}`, t = host(linkId);
    expect(await myPin(t.pins, linkId, fileWire, false, undefined, 5)).toMatchObject({ id: fileWire, messageId: `me_${at}` });
    expect(await myPin(t.pins, linkId, `me_${at}`, false, undefined, 5)).toMatchObject({ id: fileWire, messageId: `me_${at}` });
    expect(await pinnedRow(t.pins, linkId, fileWire)).toMatchObject({ id: `me_${at}` });
    expect(t.whole).not.toHaveBeenCalled();
    // One its keys do not find is looked for in the whole chat, and refused when it is not there.
    expect(await myPin(t.pins, linkId, "N".repeat(22), false, undefined, 5)).toEqual({ error: expect.stringMatching(/not in this chat/) });
    expect(t.whole).toHaveBeenCalledTimes(1);
  });
});

describe("a pin the contact makes", () => {
  it("on a file of mine finds its row by the stored file, without reading the whole chat", async () => {
    const linkId = `pins-${crypto.randomUUID()}`, file = chatRows(linkId).at(-1)!.file!;
    for (const row of chatRows(linkId)) await db.putMessage(row);
    await fileStore.put({ id: file.id, linkId, blob: new Blob([new Uint8Array(5)]), createdAt: 1, direction: "out", wireId: fileWire, metadata: { name: file.name, size: file.size, mime: file.mime, timestamp: at } });
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    cleanup.push(async () => { await node.shutdown(); await fileStore.delete(file.id); await db.deleteLink(linkId); });
    const whole = vi.spyOn(db, "getMessages");
    cleanup.push(async () => whole.mockRestore());
    const pinCame = (chat: string, id: string) => (node as unknown as { pinCame(c: string, by: string, pin: { id: string; n: number }): Promise<StoredPin> }).pinCame(chat, "peer", { id, n: 1 });
    expect(await pinCame(linkId, fileWire)).toMatchObject({ id: fileWire, by: "peer", messageId: `me_${at}` });
    expect(await pinCame(linkId, wire(3))).toMatchObject({ id: wire(3), messageId: `me_${wire(3)}` });
    expect(whole.mock.calls.filter(([chat]) => chat === linkId)).toHaveLength(0);
  });
});
