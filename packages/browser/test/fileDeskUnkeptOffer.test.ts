import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { FileDesk } from "../src/engine/fileDesk";
import { fileBytes, resetFileBytes } from "../src/shared/fileBytes";
import { digestText } from "../src/shared/fileBytesCommon";
import { fileStore } from "../src/shared/idb";
// covers: files.large.offer

afterEach(async () => { await fileStore.deleteForLink("chat"); resetFileBytes(); vi.restoreAllMocks(); });

const bytes = new TextEncoder().encode("the whole file, in one piece");
const data = Buffer.from(bytes).toString("base64url");
const digest = digestText(new Uint8Array(createHash("sha256").update(bytes).digest()));
const offer = (id: string) => ({ t: "pf-offer", id, name: "notes.txt", mime: "text/plain", size: bytes.length, ts: 1_700_000_000_000 });

function receiver(storeMessage: () => Promise<void>) {
  const sent: Record<string, unknown>[] = [], stored: string[] = [];
  const transfers = new Map<string, unknown>(), used = new Set<string>();
  const desk = new FileDesk({
    send: (_link, frame) => { sent.push(frame); return true; },
    receivedBytes: () => 0,
    wireIds: () => used,
    deleted: () => false,
    messageExists: async () => false,
    storeMessage: async (message) => { await storeMessage(); stored.push(message.id); },
    transfers: transfers as never,
    changed: () => {},
  });
  desk.session("chat", true);
  return { desk, sent, stored, transfers, used };
}

/** Offers the file, sends its bytes and its sum once it is accepted, and waits for what the receiver says last. */
async function deliver(desk: FileDesk, sent: Record<string, unknown>[], id: string): Promise<void> {
  const from = sent.length, said = (...t: string[]) => sent.slice(from).some((f) => f.id === id && t.includes(f.t as string));
  await desk.handle("chat", offer(id));
  await vi.waitFor(() => expect(said("pf-accept", "pf-refuse")).toBe(true));
  if (said("pf-refuse")) return;
  await desk.handle("chat", { t: "pf-data", id, offset: 0, data });
  await desk.handle("chat", { t: "pf-sum", id, size: bytes.length, digest });
  await vi.waitFor(() => expect(said("pf-done", "pf-refuse")).toBe(true));
}

const full = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

/**
 * A new offer's file record and chat message are written on the chat's write chain, whose errors were swallowed. One of
 * them refused (a device near its quota) and the transfer went on: every byte stored, `pf-done` sent, the sender's bubble
 * said delivered, and this side had no message for it, before or after a restart (a refused record left its bytes under
 * an id nothing names). The offer is refused instead, nothing of it stays, and the sender's Retry is taken as new.
 */
it.each([
  ["its chat message", "message"],
  ["its file record", "record"],
] as const)("refuses an offer when %s could not be stored, keeps nothing of it, and takes it when sent again", async (_what, refused) => {
  resetFileBytes(["idb"]);
  let fail = refused === "message";
  const put = fileStore.put.bind(fileStore);
  const puts = vi.spyOn(fileStore, "put").mockImplementation(put);
  if (refused === "record") puts.mockRejectedValueOnce(full());
  const { desk, sent, stored, transfers, used } = receiver(async () => { if (fail) { fail = false; throw full(); } });

  await deliver(desk, sent, "wUnkeptFile1");
  expect(sent.filter((f) => f.t === "pf-done")).toEqual([]);
  expect(sent.filter((f) => f.t === "pf-refuse")).toEqual([{ t: "pf-refuse", id: "wUnkeptFile1", why: "no-room" }]);
  await vi.waitFor(async () => expect(await fileStore.listForLink("chat")).toEqual([]));
  expect(await (await fileBytes()).size(puts.mock.calls[0][0].id)).toBe(null);
  expect(transfers.size).toBe(0);
  expect(used.has("wUnkeptFile1")).toBe(false);
  expect(stored).toEqual([]);

  // The sender's Retry: the same offer again, taken and kept this time.
  await deliver(desk, sent, "wUnkeptFile1");
  expect(sent.filter((f) => f.t === "pf-done")).toEqual([{ t: "pf-done", id: "wUnkeptFile1" }]);
  expect(stored).toEqual(["peer_wUnkeptFile1"]);
  const [file] = await fileStore.listForLink("chat");
  expect(file.wire3?.state).toBe("done");
  expect(await (await fileBytes()).size(file.id)).toBe(bytes.length);
});

/** A file said on the floor: its bubble says it was refused here, and the sender's Retry takes it over again. */
it("refuses the offer of a file said on the floor whose record could not be stored, and its bubble says so", async () => {
  resetFileBytes(["idb"]);
  const put = fileStore.put.bind(fileStore);
  vi.spyOn(fileStore, "put").mockRejectedValueOnce(full()).mockImplementation(put);
  const { desk, sent, transfers } = receiver(async () => {});
  expect(desk.announce("chat", "wUnkeptFile3", "chat-in-floor", bytes.length)).toBe(true);

  await deliver(desk, sent, "wUnkeptFile3");
  expect(sent.filter((f) => f.t === "pf-done" || f.t === "pf-refuse")).toEqual([{ t: "pf-refuse", id: "wUnkeptFile3", why: "no-room" }]);
  expect(transfers.get("chat-in-floor")).toMatchObject({ state: "failed", error: "No room on this device for this file" });

  await deliver(desk, sent, "wUnkeptFile3");
  expect(sent.filter((f) => f.t === "pf-done")).toEqual([{ t: "pf-done", id: "wUnkeptFile3" }]);
  expect(await (await fileBytes()).size("chat-in-floor")).toBe(bytes.length);
});

it("refuses as invalid when the write failed for another reason than room", async () => {
  resetFileBytes(["idb"]);
  let fail = true;
  const { desk, sent } = receiver(async () => { if (fail) { fail = false; throw new DOMException("Connection to Indexed Database server lost.", "UnknownError"); } });
  await deliver(desk, sent, "wUnkeptFile2");
  expect(sent.filter((f) => f.t === "pf-done" || f.t === "pf-refuse")).toEqual([{ t: "pf-refuse", id: "wUnkeptFile2", why: "invalid" }]);
});
