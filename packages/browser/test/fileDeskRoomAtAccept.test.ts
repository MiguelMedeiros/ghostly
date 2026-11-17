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
  resetFileBytes();
  vi.unstubAllGlobals();
});

/** A desk whose device has `free()` bytes left, its files in IndexedDB, and two chats with an open session. */
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
  files.session("chat-a", true);
  files.session("chat-b", true);
  /** The local id of a file offered here, once the person is asked about it, and the room its offer shows. */
  const offered = async (link: string, id: string, size: number) => {
    await files.handle(link, { t: "pf-offer", id, name: `${id}.mp4`, mime: "video/mp4", size, ts: 1_700_000_000_000 });
    await vi.waitFor(() => expect(sent.some(({ frame }) => frame.t === "pf-wait" && frame.why === "consent" && frame.id === id)).toBe(true));
    const local = [...transfers].find(([key, view]) => key.startsWith(`${link}-in-`) && view.stage === "asking" && view.size === size)![0];
    await vi.waitFor(() => expect(transfers.get(local)?.room).toBeTypeOf("number"));
    return local;
  };
  const accepted = () => sent.filter(({ frame }) => frame.t === "pf-accept").map(({ frame }) => frame.id);
  return { files, sent, transfers, offered, accepted };
}

/**
 * An offer that waits for the person showed the room read when it came, and Accept started it with no look at the room:
 * files taken meanwhile had filled the disk, and it failed part way, its bytes thrown away (found with two CLIs on a
 * 40 MiB disk: 32 MB shown, 16 MB left, a 24 MB file accepted and failed at 8 MB). Accept reads the room first: one that
 * does not fit is not started, says why with the room left, and keeps waiting, every waiting offer showing that room;
 * once there is room again, Accept takes it.
 */
it("Accept on an offer larger than the room left now does not start it: it keeps waiting, the room read shown, and goes once there is room", async () => {
  let free = 100 * MiB;
  const t = desk(() => free);
  const big = await t.offered("chat-a", "wRoomGone01", 60 * MiB);
  const other = await t.offered("chat-b", "wRoomGone02", 30 * MiB);
  expect(t.transfers.get(big)?.room).toBe(100 * MiB);
  // Other files took the space meanwhile: 40 MiB left.
  free = 40 * MiB;
  const answer = await t.files.accept("chat-a", big).then(() => null, (error: Error) => error);
  // Not started: nothing asked of the sender, and it still waits for the person.
  expect(t.accepted()).toEqual([]);
  expect(t.transfers.get(big)).toMatchObject({ state: "transferring", stage: "asking", direction: "in" });
  expect(answer).toMatchObject({ message: "No room on this device for this file (40.0 MB free)", room: 40 * MiB });
  // Every offer waiting shows the room read, not the one of when it came.
  expect(t.transfers.get(big)?.room).toBe(40 * MiB);
  expect(t.transfers.get(other)?.room).toBe(40 * MiB);
  // Room made: Accept takes it.
  free = 100 * MiB;
  await t.files.accept("chat-a", big);
  await vi.waitFor(() => expect(t.accepted()).toEqual(["wRoomGone01"]));
  t.files.drop("chat-a");
  t.files.drop("chat-b");
});

/**
 * The room left is what the files already taken do not still need, as when an offer is decided: with 100 MiB free and
 * a 60 MiB file taken and not come yet, a second 60 MiB one fits the disk now but not beside it, and is not started.
 */
it("Accept counts what the files already taken still need: one that fits only without them is not started", async () => {
  let free = 100 * MiB;
  const t = desk(() => free);
  const first = await t.offered("chat-a", "wBesideIt01", 60 * MiB);
  const second = await t.offered("chat-b", "wBesideIt02", 60 * MiB);
  await t.files.accept("chat-a", first);
  await vi.waitFor(() => expect(t.accepted()).toEqual(["wBesideIt01"]));
  await expect(t.files.accept("chat-b", second)).rejects.toMatchObject({ message: "No room on this device for this file (100.0 MB free)", room: 100 * MiB });
  expect(t.accepted()).toEqual(["wBesideIt01"]);
  expect(t.transfers.get(second)).toMatchObject({ stage: "asking" });
  // The one under way ends (cancelled here): the offer waiting shows the room it leaves, and fits now.
  free = 90 * MiB;
  t.files.act("chat-a", first, "cancel");
  await vi.waitFor(() => expect(t.transfers.get(second)?.room).toBe(90 * MiB));
  await t.files.accept("chat-b", second);
  await vi.waitFor(() => expect(t.accepted()).toEqual(["wBesideIt01", "wBesideIt02"]));
  t.files.drop("chat-a");
  t.files.drop("chat-b");
});
