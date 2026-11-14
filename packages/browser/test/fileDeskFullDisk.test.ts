import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";
import { FileDesk, type FileDeskDeps } from "../src/engine/fileDesk";
import { resetFileBytes } from "../src/shared/fileBytes";
import { fileStore } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.resume

let full = false;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quota = () => new DOMException("This device has no room left to save this", "QuotaExceededError");
const { put, add } = IDBObjectStore.prototype;
IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) { if (full) throw quota(); return put.apply(this, args); };
IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) { if (full) throw quota(); return add.apply(this, args); };

afterEach(() => { full = false; resetFileBytes(); });

const desk = (transfers: Map<string, FileTransferView>, sent: Record<string, unknown>[] = []) => new FileDesk({
  send: (_link, frame) => { sent.push(frame); return true; },
  receivedBytes: () => 0,
  wireIds: () => new Set(),
  deleted: () => false,
  messageExists: async () => false,
  storeMessage: async () => {},
  transfers,
  changed: () => {},
} satisfies FileDeskDeps);

/**
 * On a full disk a received file fails cleanly (its pieces removed, its sender told `no-room`), but the write of that
 * failure is refused by the same full disk and was dropped: its record still said under way. After space was freed and
 * the app restarted, the file showed as arriving and stuck, then as "Cancelled by the sender" once its sender answered
 * the nudge. The refused write is made again until it goes, so the restart shows why it ended.
 */
it("keeps a received file's failure on a full disk and writes it once there is room, so a restart shows it", async () => {
  resetFileBytes(["idb"]);
  const transfers = new Map<string, FileTransferView>(), sent: Record<string, unknown>[] = [];
  const receiver = desk(transfers, sent);
  receiver.session("chat", true);
  const size = 3 * 1024 * 1024, chunk = 16 * 1024;
  await receiver.handle("chat", { t: "pf-offer", id: "wFullDisk01", name: "big.bin", mime: "application/octet-stream", size, ts: 1_700_000_000_000 });
  await settle(100);
  const [id] = [...transfers.keys()];
  // The disk fills once the first piece (1 MiB) is stored.
  for (let offset = 0; offset < size; offset += chunk) {
    if (offset === 1536 * 1024) full = true;
    await receiver.handle("chat", { t: "pf-data", id: "wFullDisk01", offset, data: toBase64Url(new Uint8Array(chunk).fill(7)) });
    await settle(2);
  }
  await vi.waitFor(() => expect(sent).toContainEqual({ t: "pf-refuse", id: "wFullDisk01", why: "no-room" }));
  expect(transfers.get(id)).toMatchObject({ state: "failed", error: expect.stringContaining("Could not store the file") });
  await settle(100);
  // Its end could not be written.
  expect((await fileStore.get(id))?.wire3?.state).toBe("active");

  // Space is freed, nothing else is written, and the app restarts a while later (fake-indexeddb runs on real timers).
  full = false;
  await settle(6_000);
  receiver.drop("chat");
  expect((await fileStore.get(id))?.wire3?.state).toBe("failed");
  const restarted = new Map<string, FileTransferView>();
  desk(restarted).restore("chat", await fileStore.listForLink("chat"));
  expect(restarted.get(id)).toMatchObject({ state: "failed", error: expect.stringContaining("Could not store the file") });
}, 20_000);
