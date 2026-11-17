import "fake-indexeddb/auto";
import { ChatFiles, type FileTransferRecord } from "@ghostly/core";
import { afterEach, expect, it, vi } from "vitest";
import { FileDesk } from "../src/engine/fileDesk";
import { resetFileBytes } from "../src/shared/fileBytes";
import { fileStore, type StoredFile } from "../src/shared/idb";
// covers: files.large.offer

const MiB = 1024 * 1024;

afterEach(async () => {
  vi.restoreAllMocks();
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

/**
 * Offers from several contacts that come at the same moment (a device back online, each contact's waiting files offered
 * on its own session) were each decided before any of them was recorded: none saw the others, and all were taken
 * without asking though together they did not fit (two 20 MiB files with 30 MiB free). An offer being decided counts
 * as still to come for the others decided beside it.
 */
it.each([
  { free: 30, size: 20, links: ["chat-a", "chat-b"] },
  { free: 32, size: 15, links: ["chat-a", "chat-b", "chat-c"] },
])("asks about offers from contacts at the same moment that together do not fit ($links.length × $size MiB, $free MiB free)", async ({ free, size, links }) => {
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: free * MiB, usage: 0 }) } });
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
  for (const link of links) desk.session(link, true);
  const ids = links.map((link) => `wAtOnce${link.slice(-1)}01`);
  await Promise.all(links.map((link, i) => desk.handle(link, { t: "pf-offer", id: ids[i], name: `${ids[i]}.mp4`, mime: "video/mp4", size: size * MiB, ts: 1_700_000_000_000 })));
  const answered = (t: string) => sent.filter(({ frame }) => frame.t === t && (t !== "pf-wait" || frame.why === "consent")).map(({ frame }) => frame.id);
  // As many as fit together are taken, the first ones; the rest are asked about.
  const fit = Math.floor(free / size);
  await vi.waitFor(() => expect(answered("pf-accept")).toEqual(ids.slice(0, fit)));
  await vi.waitFor(() => expect(answered("pf-wait")).toEqual(ids.slice(fit)));
  expect(sent.filter(({ frame }) => frame.t === "pf-refuse")).toEqual([]);
  for (const link of links) desk.drop(link);
  await fileStore.deleteForLink("chat-c");
});

/**
 * What is still to come was read by copying every record of every chat, the finished ones the chats keep for good
 * included: each offer cost more with every file the profile ever had (about 10 ms at 200 chats of 500 files). It is
 * read from the transfers not ended alone, and answers the same.
 */
it("answers an offer from the files still on their way, without reading every file each chat ever had", async () => {
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
  const record = (id: string, direction: "in" | "out", size: number, state: FileTransferRecord["state"], confirmed: number): FileTransferRecord =>
    ({ id, direction, file: { id, name: `${id}.jpg`, mime: "image/jpeg", size, timestamp: 1 }, state, confirmed, since: Date.now() });
  for (const link of ["chat-a", "chat-b"]) {
    const kept: StoredFile[] = [];
    for (let i = 0; i < 500; i++) {
      const direction = i % 2 ? "in" : "out", id = `wDone${link.slice(-1)}${String(i).padStart(4, "0")}`;
      kept.push({ id: `${link}-${direction}-${id}`, wire3: record(id, direction, 1000, "done", 1000) } as StoredFile);
    }
    // One still arriving: 85 of its 90 MiB to come.
    if (link === "chat-a") kept.push({ id: "local-arriving", wire3: record("wArriving01", "in", 90 * MiB, "active", 5 * MiB) } as StoredFile);
    desk.restore(link, kept);
    desk.session(link, true);
  }
  const records = vi.spyOn(ChatFiles.prototype, "records");
  await desk.handle("chat-b", { t: "pf-offer", id: "wNewOffer01", name: "new.mp4", mime: "video/mp4", size: 20 * MiB, ts: 1_700_000_000_000 });
  // 20 MiB fit in the 100 free only without the 85 still to come: asked about, not taken.
  await vi.waitFor(() => expect(sent.filter(({ frame }) => frame.t === "pf-wait" && frame.why === "consent").map(({ frame }) => frame.id)).toEqual(["wNewOffer01"]));
  expect(desk.moving("chat-a")).toBe(true);
  expect(desk.moving("chat-b")).toBe(false);
  expect(records).not.toHaveBeenCalled();
  desk.drop("chat-a");
  desk.drop("chat-b");
});
