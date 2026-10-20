import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_RANGES_CAPABILITY, type AppRangeTask, type GhostLink } from "@ghostly/core";
import type { EngineEvent } from "../src/shared/rpc";
import { appsChat } from "./helpers/appsChat";
// covers: apps.ranges.wire

/**
 * The read lane in the engine (`app-ranges/1`, WISP 1200 § A read lane to the contact): a page serves one of its app's
 * linked files and answers each range the contact's app asks (`app-range` events, `appRangeAnswer`); and reads what the
 * contact's app serves (`appRemoteRead`).
 */

vi.mock("../src/shared/features", async (actual) => ({ ...await actual<typeof import("../src/shared/features")>(), APPS_ENABLED: false }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const step of cleanup.splice(0).reverse()) await step(); });

const FILM = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 13 + 1) & 0xff);
const settled = async <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: Error) => ({ error: error.message }));

async function setup() {
  let contactLink: GhostLink | null = null;
  const chat = await appsChat(cleanup, {
    apps: true,
    contact: {
      appRangesSupport: true,
      // The contact serves FILM under "film" and nothing else.
      events: { onAppRangeTask: (task: AppRangeTask) => {
        if (task.file !== "film") return contactLink!.failAppRange(task, "gone");
        void contactLink!.sendAppRange(task, FILM.subarray(task.offset, task.offset + task.length), FILM.length);
      } },
    },
  });
  contactLink = chat.contact;
  const { call, contact, id, ref, app } = chat;
  await vi.waitFor(() => expect(contact.supportsAppRanges).toBe(true));
  await call("appOpen", { linkId: id, ref, version: "1.0.0" });
  contact.openApp(app, "1.0.0");
  await vi.waitFor(() => expect(chat.appEvents()).toHaveLength(1));
  const ranges = () => chat.events.filter((e): e is Extract<EngineEvent, { kind: "app-range" }> => e.kind === "app-range");
  return { ...chat, ranges };
}

describe("the read lane in the engine", () => {
  it("offers app-ranges/1 beside apps/1 where apps run", async () => {
    const { contact } = await setup();
    expect(contact.sessionOffers.peer).toContain(APP_RANGES_CAPABILITY);
  });

  it("a page reads a range of what the contact's app serves, and learns the file's size", async () => {
    const { call, contact, id, ref, app } = await setup();
    const served = contact.serveAppFile(app, "film") as { serve: string };
    const read = await call("appRemoteRead", { linkId: id, ref, serve: served.serve, offset: 50_000, length: 200_000 }) as { bytes: Uint8Array; size: number };
    expect(read.size).toBe(FILM.length);
    expect(read.bytes).toEqual(FILM.subarray(50_000, 250_000));
    expect(await call("appRemoteRead", { linkId: id, ref, serve: (contact.serveAppFile(app, "other") as { serve: string }).serve, offset: 0, length: 1 })).toEqual({ error: "gone" });
    expect(await call("appRemoteRead", { linkId: id, ref, serve: "not-a-serve-id", offset: 0, length: 1 })).toEqual({ error: "not-served" });
    expect(await call("appRemoteRead", { linkId: id, ref, serve: served.serve.replace(/^./, c => c === "A" ? "B" : "A"), offset: 0, length: 1 })).toEqual({ error: "not-served" });
    expect(await settled(call("appRemoteRead", { linkId: id, ref, serve: served.serve, offset: 0, length: 1024 * 1024 + 1 }))).toEqual({ error: "Not a range" });
  });

  it("a page serves one of its files: each range the contact asks comes to the pages, and the answer goes back", async () => {
    const { call, contact, id, ref, app, ranges } = await setup();
    const served = await call("appServe", { linkId: id, ref, file: "LinkIdOfAFilm000000000" }) as { serve: string };
    expect(served.serve).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const reading = contact.readAppRange(app, served.serve, 1_000, 40_000);
    await vi.waitFor(() => expect(ranges()).toHaveLength(1));
    const [{ linkId, range }] = ranges();
    expect(linkId).toBe(id);
    expect(range).toEqual({ app, request: range.request, serve: served.serve, file: "LinkIdOfAFilm000000000", offset: 1_000, length: 40_000 });
    await call("appRangeAnswer", { linkId: id, app, request: range.request, bytes: FILM.subarray(1_000, 41_000), size: FILM.length });
    expect(await reading).toEqual({ bytes: FILM.subarray(1_000, 41_000), size: FILM.length });
    // A file that changed under the link says so; an answer for a request nobody waits on is dropped.
    const changed = contact.readAppRange(app, served.serve, 0, 1);
    await vi.waitFor(() => expect(ranges()).toHaveLength(2));
    await call("appRangeAnswer", { linkId: id, app, request: ranges()[1].range.request, error: "changed" });
    expect(await settled(changed)).toEqual({ error: "changed" });
    await call("appRangeAnswer", { linkId: id, app, request: ranges()[1].range.request, bytes: FILM.subarray(0, 1), size: FILM.length });
    // Unserved: the contact's next read is refused.
    await call("appUnserve", { linkId: id, serve: served.serve });
    expect(await settled(contact.readAppRange(app, served.serve, 0, 1))).toEqual({ error: "not-served" });
  });

  it("a request number the contact cancelled and asks again gets the bytes of its new ask, not the answer to the first", async () => {
    const { call, contact, id, ref, app, ranges } = await setup();
    const first = await call("appServe", { linkId: id, ref, file: "LinkIdOfAFilm000000000" }) as { serve: string };
    const second = await call("appServe", { linkId: id, ref, file: "LinkIdOfASong000000000" }) as { serve: string };
    // What reaches the contact's side for its request 9, as another client of the wire would ask it.
    const lane = (contact as unknown as { appRanges: { receiveData(...args: unknown[]): void; receiveAnswer(frame: unknown): void } }).appRanges;
    const data = vi.spyOn(lane, "receiveData"), answers = vi.spyOn(lane, "receiveAnswer");
    const raw = (frame: object) => (contact as unknown as { channel: { send(data: string): void } }).channel.send(JSON.stringify(frame));
    raw({ t: "ar-get", a: app, s: first.serve, r: 9, o: 0, n: 4 });
    await vi.waitFor(() => expect(ranges()).toHaveLength(1));
    // Cancelled, its number frees (WISP 1200), and the contact asks under it again, of the other file.
    raw({ t: "ar-cancel", a: app, r: 9 });
    raw({ t: "ar-get", a: app, s: second.serve, r: 9, o: 100, n: 4 });
    await vi.waitFor(() => expect(ranges()).toHaveLength(2));
    const [a, b] = ranges().map(event => event.range);
    expect([a.file, b.file]).toEqual(["LinkIdOfAFilm000000000", "LinkIdOfASong000000000"]);
    // The page answers each ask as it heard it: the film's first, then the song's.
    await call("appRangeAnswer", { linkId: id, app, request: a.request, bytes: Uint8Array.of(1, 1, 1, 1), size: 1_000 });
    await call("appRangeAnswer", { linkId: id, app, request: b.request, bytes: Uint8Array.of(2, 2, 2, 2), size: 2_000 });
    await vi.waitFor(() => expect(answers).toHaveBeenCalledTimes(1));
    expect(answers.mock.calls[0]![0]).toMatchObject({ t: "ar-end", r: 9, z: 2_000 });
    expect(data.mock.calls.map(([, request, offset, bytes]) => [request, offset, [...bytes as Uint8Array]])).toEqual([[9, 100, [2, 2, 2, 2]]]);
    // The cancelled ask, answered late, gave its place back: the app takes 4 asks in flight again, none `busy`.
    for (let r = 10; r < 14; r++) raw({ t: "ar-get", a: app, s: first.serve, r, o: 0, n: 1 });
    await vi.waitFor(() => expect(ranges()).toHaveLength(6));
    expect(answers).toHaveBeenCalledTimes(1);
  });

  it("serves only while the contact's app is open, and says why not", async () => {
    const { call, contact, contactGot, id, ref, app, appEvents } = await setup();
    contact.closeApp(app);
    await vi.waitFor(() => expect(appEvents().at(-1)?.event).toEqual({ app, o: "close" }));
    expect(await call("appServe", { linkId: id, ref, file: "film" })).toEqual({ error: "peer-closed" });
    await call("appClose", { linkId: id, ref });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, o: "close" }));
    expect(await call("appServe", { linkId: id, ref, file: "film" })).toEqual({ error: "not-open" });
    expect(await call("appRemoteRead", { linkId: id, ref, serve: "A".repeat(22), offset: 0, length: 1 })).toEqual({ error: "not-open" });
  });
});
