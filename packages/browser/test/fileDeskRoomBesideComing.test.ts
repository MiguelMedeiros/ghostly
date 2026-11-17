import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { FileDesk } from "../src/engine/fileDesk";
import { resetFileBytes } from "../src/shared/fileBytes";
import { fileStore } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.offer

const MiB = 1024 * 1024;

afterEach(async () => {
  vi.restoreAllMocks();
  await fileStore.deleteForLink("chat-a");
  await fileStore.deleteForLink("chat-b");
  await fileStore.deleteForLink("chat-c");
  resetFileBytes();
  vi.unstubAllGlobals();
});

/** A desk whose device has `free()` bytes left, its files in IndexedDB, and three chats with an open session. */
function desk(free: () => number) {
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 1000 * MiB, usage: 1000 * MiB - free() }) } });
  resetFileBytes(["idb"]);
  const sent: { link: string; frame: Record<string, unknown> }[] = [];
  const transfers = new Map<string, FileTransferView>();
  const files = new FileDesk({
    send: (link, frame) => { sent.push({ link, frame }); return true; },
    receivedBytes: () => 0,
    wireIds: () => new Set(),
    deleted: () => false,
    messageExists: async () => false,
    storeMessage: async () => {},
    transfers,
    changed: () => {},
  });
  for (const link of ["chat-a", "chat-b", "chat-c"]) files.session(link, true);
  /** The local id of a file offered here, once the person is asked about it and its offer shows a room. */
  const offered = async (link: string, id: string, size: number) => {
    await files.handle(link, { t: "pf-offer", id, name: `${id}.mp4`, mime: "video/mp4", size, ts: 1_700_000_000_000 });
    await vi.waitFor(() => expect(sent.some(({ frame }) => frame.t === "pf-wait" && frame.why === "consent" && frame.id === id)).toBe(true));
    const local = [...transfers].find(([key, view]) => key.startsWith(`${link}-in-`) && view.stage === "asking" && view.size === size)![0];
    await vi.waitFor(() => expect(transfers.get(local)?.room).toBeTypeOf("number"));
    return local;
  };
  const accepted = () => sent.filter(({ frame }) => frame.t === "pf-accept").map(({ frame }) => frame.id);
  return { files, transfers, offered, accepted };
}

/**
 * The room an offer waiting for the person shows is the room left for it beside the files already taken that still
 * come, as Accept decides it: with 100 MiB free and a 60 MiB file taken and not come yet, a second 60 MiB offer showed
 * "100 MB free", the line that says it fits, and Accept refused it for no room. Found with two CLIs on a 40 MiB disk: a
 * 27 MB file shown beside "38.9 MB free" and refused, another 27 MB one still coming.
 */
it("an offer waiting shows the room left beside the files taken that still come, from the moment one is taken", async () => {
  let free = 100 * MiB;
  const t = desk(() => free);
  const first = await t.offered("chat-a", "wBeside0001", 60 * MiB);
  const second = await t.offered("chat-b", "wBeside0002", 60 * MiB);
  const small = await t.offered("chat-c", "wBeside0003", 30 * MiB);
  expect(t.transfers.get(second)?.room).toBe(100 * MiB);
  await t.files.accept("chat-a", first);
  await vi.waitFor(() => expect(t.accepted()).toEqual(["wBeside0001"]));
  // Taken, it will use 60 MiB of the 100: 40 left for each offer waiting. The second no longer reads as fitting; the small one does.
  await vi.waitFor(() => expect(t.transfers.get(second)?.room).toBe(40 * MiB));
  expect(t.transfers.get(small)?.room).toBe(40 * MiB);
  // Accept on the second says what holds the room: it fits the 100 MiB free, not beside the 60 MiB still coming.
  await expect(t.files.accept("chat-b", second)).rejects.toMatchObject({
    message: "No room on this device for this file beside the files still coming (40.0 MB left of 100.0 MB free)", room: 100 * MiB,
  });
  expect(t.accepted()).toEqual(["wBeside0001"]);
  expect(t.transfers.get(second)).toMatchObject({ stage: "asking", room: 40 * MiB });
  // The one under way ends (cancelled here): nothing still comes, and the offers show the disk's free space again.
  free = 90 * MiB;
  t.files.act("chat-a", first, "cancel");
  await vi.waitFor(() => expect(t.transfers.get(second)?.room).toBe(90 * MiB));
  expect(t.transfers.get(small)?.room).toBe(90 * MiB);
  for (const link of ["chat-a", "chat-b", "chat-c"]) t.files.drop(link);
});
