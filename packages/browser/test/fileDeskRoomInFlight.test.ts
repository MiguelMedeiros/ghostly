import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { FileDesk } from "../src/engine/fileDesk";
import { resetFileBytes } from "../src/shared/fileBytes";
import { fileStore } from "../src/shared/idb";
// covers: files.large.offer

const MiB = 1024 * 1024;

afterEach(async () => {
  await fileStore.deleteForLink("chat-a");
  await fileStore.deleteForLink("chat-b");
  resetFileBytes();
  vi.unstubAllGlobals();
});

/**
 * Each offer was checked alone against the room this device has left: files taken without asking and still on their
 * way were not counted, so a few of them together could take more than there is (with 100 MiB free, six 20 MiB files
 * from two contacts were all taken, and the disk filled half way through). What is still to come of the files already
 * taken counts too: an offer that fits only without them is asked about, not taken.
 */
it("takes without asking only what fits beside the files still on their way, from every chat", async () => {
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 100 * MiB, usage: 0 }) } });
  resetFileBytes(["idb"]);
  const sent: { link: string; frame: Record<string, unknown> }[] = [];
  const desk = new FileDesk({
    send: (link, frame) => { sent.push({ link, frame }); return true; },
    receivedBytes: () => 0,
    wireIds: () => new Set(),
    deleted: () => false,
    messageExists: async () => false,
    storeMessage: async () => {},
    transfers: new Map(),
    changed: () => {},
  });
  desk.session("chat-a", true);
  desk.session("chat-b", true);
  const offer = (id: string) => ({ t: "pf-offer", id, name: `${id}.mp4`, mime: "video/mp4", size: 20 * MiB, ts: 1_700_000_000_000 });
  // Five fill the 100 MiB exactly; the sixth does not fit beside them.
  for (const [link, id] of [["chat-a", "wInFlight01"], ["chat-b", "wInFlight02"], ["chat-a", "wInFlight03"], ["chat-b", "wInFlight04"], ["chat-a", "wInFlight05"], ["chat-b", "wInFlight06"]]) {
    await desk.handle(link, offer(id));
  }
  const asked = () => sent.filter(({ frame }) => frame.t === "pf-wait" && frame.why === "consent").map(({ frame }) => frame.id);
  await vi.waitFor(() => expect(asked()).toEqual(["wInFlight06"]));
  expect(sent.filter(({ frame }) => frame.t === "pf-refuse")).toEqual([]);
});
