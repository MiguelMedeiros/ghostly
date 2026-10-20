import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/bytes";
import { APP_RANGE_LIMITS, AppRanges, appRangeChunk, appRangeGetFrame, type AppRangeFrame, type AppRangeTask } from "../src/pairedAppRanges";
// covers: apps.ranges.wire

/**
 * One chat's read lane, both ways (WISP 1200 § A read lane to the contact): Ana serves a file of her app, Bob's app
 * reads it. Frames go through `readAppRangeFrame` as the session will pass them; the bytes are read from a buffer and
 * sent in chunks, as the session will.
 */

const CHESS = toBase64Url(new Uint8Array(16).fill(1));
const CINEMA = toBase64Url(new Uint8Array(16).fill(2));
const FILM = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) % 256);

function pair(options: { serveFile?: (file: string) => Uint8Array | "changed" | "gone"; hold?: boolean } = {}) {
  const toAna: AppRangeFrame[] = [], toBob: AppRangeFrame[] = [];
  let ids = 0;
  const ana = new AppRanges(frame => toBob.push(frame), () => toBase64Url(new Uint8Array(16).fill(100 + ids++)));
  const bob = new AppRanges(frame => toAna.push(frame));
  const tasks: AppRangeTask[] = [];
  /** Ana answers a task: chunks of 16 KiB at most, then `ar-end` with the file's size. */
  const answer = (task: AppRangeTask) => {
    const file = (options.serveFile ?? (() => FILM))(task.file);
    if (typeof file === "string") return ana.fail(task, file);
    const end = Math.min(file.length, task.offset + task.length);
    for (let at = task.offset; at < end && task.live; at += APP_RANGE_LIMITS.chunkBytes) {
      const chunk = file.subarray(at, Math.min(end, at + APP_RANGE_LIMITS.chunkBytes));
      toBob.push({ t: "ar-data", a: task.app, r: task.request, o: at, d: toBase64Url(chunk) });
    }
    ana.finish(task, file.length);
  };
  /** Delivers every frame in flight, both ways, until none is left. */
  const flush = () => {
    while (toAna.length || toBob.length) {
      for (const frame of toAna.splice(0)) {
        if (frame.t === "ar-get") { const task = ana.receiveGet(frame); if (task) { tasks.push(task); if (!options.hold) answer(task); } }
        else if (frame.t === "ar-cancel") ana.receiveCancel(frame);
      }
      for (const frame of toBob.splice(0)) {
        if (frame.t === "ar-data") bob.receiveData(frame.a, frame.r, frame.o, appRangeChunk(frame.d)!);
        else if (frame.t === "ar-end" || frame.t === "ar-err") bob.receiveAnswer(frame);
      }
    }
  };
  return { ana, bob, toAna, toBob, tasks, answer, flush };
}

const settled = async <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: Error) => ({ error: error.message }));

describe("the read lane of one chat", () => {
  it("reads a served range, in chunks put back in order, and the file's size", async () => {
    const { ana, bob, flush } = pair();
    const serve = ana.serve(CINEMA, "film-id");
    expect(serve).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ana.servesOf(CINEMA)).toEqual([serve]);
    const read = bob.read(CINEMA, serve, 1_000, 40_000);
    flush();
    expect(await read).toEqual({ bytes: FILM.subarray(1_000, 41_000), size: FILM.length });
  });

  it("answers fewer bytes at the end of the file, and none past it", async () => {
    const { ana, bob, flush } = pair();
    const serve = ana.serve(CINEMA, "film-id");
    const tail = bob.read(CINEMA, serve, FILM.length - 10, 1_000), past = bob.read(CINEMA, serve, FILM.length + 5, 1);
    flush();
    expect(await tail).toEqual({ bytes: FILM.subarray(FILM.length - 10), size: FILM.length });
    // Past the end: no bytes, and still the size.
    expect((await past).size).toBe(FILM.length);
    expect((await past).bytes.length).toBe(0);
  });

  it("refuses a serve id never given, another app's, and one ended", async () => {
    const { ana, bob, flush } = pair();
    const serve = ana.serve(CINEMA, "film-id");
    const unknown = bob.read(CINEMA, toBase64Url(new Uint8Array(16)), 0, 1), other = bob.read(CHESS, serve, 0, 1);
    flush();
    expect(await settled(unknown)).toEqual({ error: "not-served" });
    expect(await settled(other)).toEqual({ error: "not-served" });
    expect(ana.unserve(serve)).toBe(true);
    expect(ana.unserve(serve)).toBe(false);
    const after = bob.read(CINEMA, serve, 0, 1);
    flush();
    expect(await settled(after)).toEqual({ error: "not-served" });
  });

  it("says changed or gone as the file under a serve does", async () => {
    const { ana, bob, flush } = pair({ serveFile: file => file === "moved" ? "gone" : "changed" });
    const moved = bob.read(CINEMA, ana.serve(CINEMA, "moved"), 0, 1), edited = bob.read(CINEMA, ana.serve(CINEMA, "edited"), 0, 1);
    flush();
    expect(await settled(moved)).toEqual({ error: "gone" });
    expect(await settled(edited)).toEqual({ error: "changed" });
  });

  it("a server takes 4 requests in flight per app and answers busy past them", () => {
    const sent: AppRangeFrame[] = [];
    const server = new AppRanges(frame => sent.push(frame));
    const serve = server.serve(CINEMA, "film-id"), chess = server.serve(CHESS, "board");
    const tasks = [0, 1, 2, 3].map(r => server.receiveGet(appRangeGetFrame(CINEMA, serve, r, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>));
    expect(tasks.every(Boolean)).toBe(true);
    expect(server.receiveGet(appRangeGetFrame(CINEMA, serve, 4, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>)).toBeNull();
    expect(sent).toEqual([{ t: "ar-err", a: CINEMA, r: 4, e: "busy" }]);
    // Another app has its own four.
    expect(server.receiveGet(appRangeGetFrame(CHESS, chess, 4, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>)).not.toBeNull();
    // A request number already in flight is dropped, not answered: an answer would end the first one.
    expect(server.receiveGet(appRangeGetFrame(CINEMA, serve, 0, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>)).toBeNull();
    expect(sent).toHaveLength(1);
    server.finish(tasks[0]!, 10);
    expect(server.receiveGet(appRangeGetFrame(CINEMA, serve, 5, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>)).not.toBeNull();
  });

  it("an asker sends 4 requests per app at a time and the rest as each one ends", async () => {
    const { ana, bob, toAna, tasks, answer, flush } = pair({ hold: true });
    const serve = ana.serve(CINEMA, "film-id");
    const reads = Array.from({ length: 6 }, (_, i) => bob.read(CINEMA, serve, i * 10, 10));
    expect(toAna.filter(frame => frame.t === "ar-get")).toHaveLength(4);
    flush();
    expect(tasks).toHaveLength(4);
    answer(tasks[1]);
    flush();
    expect(tasks).toHaveLength(5);
    for (const task of tasks.slice(0)) if (task.live) answer(task);
    flush();
    for (const task of tasks.slice(5)) answer(task);
    flush();
    const bytes = await Promise.all(reads);
    bytes.forEach((read, i) => expect(read.bytes).toEqual(FILM.subarray(i * 10, i * 10 + 10)));
  });

  it("a cancel stops what is being sent, and the place it held frees", () => {
    const sent: AppRangeFrame[] = [];
    const server = new AppRanges(frame => sent.push(frame));
    const serve = server.serve(CINEMA, "film-id");
    const task = server.receiveGet(appRangeGetFrame(CINEMA, serve, 9, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>)!;
    server.receiveCancel({ t: "ar-cancel", a: CINEMA, r: 9 });
    expect(task.live).toBe(false);
    server.finish(task, 10);
    expect(sent).toEqual([]);
  });

  it("a cancelled request holds its place until it is settled, so a get and cancel loop meets busy", () => {
    const sent: AppRangeFrame[] = [];
    const server = new AppRanges(frame => sent.push(frame));
    const serve = server.serve(CINEMA, "film-id");
    const get = (r: number) => server.receiveGet(appRangeGetFrame(CINEMA, serve, r, 0, APP_RANGE_LIMITS.requestBytes) as Extract<AppRangeFrame, { t: "ar-get" }>);
    const handed: AppRangeTask[] = [];
    for (let r = 0; r < 1_000; r++) {
      const task = get(r);
      if (task) handed.push(task);
      server.receiveCancel({ t: "ar-cancel", a: CINEMA, r });
    }
    // The bytes of each are still being read: only four were handed out, the rest were busy.
    expect(handed).toHaveLength(APP_RANGE_LIMITS.inFlight);
    expect(sent).toHaveLength(1_000 - APP_RANGE_LIMITS.inFlight);
    expect(sent.every(frame => frame.t === "ar-err" && frame.e === "busy")).toBe(true);
    // Settling one, by any of the three, gives its place back and sends nothing for it.
    sent.length = 0;
    server.finish(handed[0], 10);
    server.fail(handed[1], "gone");
    server.release(handed[2]);
    expect(sent).toEqual([]);
    expect([1_000, 1_001, 1_002].map(get).every(Boolean)).toBe(true);
    expect(get(1_003)).toBeNull();
    // An unserve, a close and the session's end count the same way, and the last two free every place.
    server.closeApp(CINEMA);
    const again = server.serve(CINEMA, "film-id");
    const task = server.receiveGet(appRangeGetFrame(CINEMA, again, 7, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>)!;
    server.unserve(again);
    expect(task.live).toBe(false);
    server.reset();
    const third = server.serve(CINEMA, "film-id");
    expect([0, 1, 2, 3].every(r => server.receiveGet(appRangeGetFrame(CINEMA, third, r, 0, 1) as Extract<AppRangeFrame, { t: "ar-get" }>))).toBe(true);
  });

  it("a server takes asks for 32 MiB a second, its apps together: a get and cancel loop answered at once meets busy", () => {
    const sent: AppRangeFrame[] = [];
    const clock = { t: 1_000 };
    const server = new AppRanges(frame => sent.push(frame), undefined, () => clock.t);
    const serve = server.serve(CINEMA, "film-id"), chess = server.serve(CHESS, "board");
    const MiB = APP_RANGE_LIMITS.requestBytes;
    const get = (app: string, s: string, r: number, n = MiB) => server.receiveGet(appRangeGetFrame(app, s, r, 0, n) as Extract<AppRangeFrame, { t: "ar-get" }>);
    // Each ask read at once and cancelled: its place frees, but its read was made.
    let handed = 0;
    for (let r = 0; r < 1_000; r++) {
      const task = get(CINEMA, serve, r);
      if (task) { handed++; server.receiveCancel({ t: "ar-cancel", a: CINEMA, r }); server.release(task); }
    }
    expect(handed).toBe(APP_RANGE_LIMITS.bytesPerSecond / MiB);
    expect(sent).toHaveLength(1_000 - handed);
    expect(sent.every(frame => frame.t === "ar-err" && frame.e === "busy")).toBe(true);
    // Another app of the same contact shares the budget; a session's end does not give it back.
    expect(get(CHESS, chess, 0, 1)).toBeNull();
    server.reset();
    const again = server.serve(CINEMA, "film-id");
    expect(get(CINEMA, again, 0, 1)).toBeNull();
    // Once the second has gone, asks are taken again.
    clock.t += 1_000;
    expect(get(CINEMA, again, 1)).not.toBeNull();
  });

  it("chunks out of order, or past what was asked, fail the read and cancel it", async () => {
    const { ana, bob, toAna, flush } = pair({ hold: true });
    const serve = ana.serve(CINEMA, "film-id");
    const gap = bob.read(CINEMA, serve, 0, 100), over = bob.read(CINEMA, serve, 0, 2);
    const [first, second] = toAna.splice(0) as Extract<AppRangeFrame, { t: "ar-get" }>[];
    bob.receiveData(CINEMA, first.r, 10, FILM.subarray(10, 20));
    bob.receiveData(CINEMA, second.r, 0, FILM.subarray(0, 3));
    expect(await settled(gap)).toEqual({ error: "failed" });
    expect(await settled(over)).toEqual({ error: "failed" });
    expect(toAna).toEqual([{ t: "ar-cancel", a: CINEMA, r: first.r }, { t: "ar-cancel", a: CINEMA, r: second.r }]);
    flush();
  });

  it("an end short of what was asked, not at the end of the file, fails the read", async () => {
    const { ana, bob, toAna } = pair({ hold: true });
    const read = bob.read(CINEMA, ana.serve(CINEMA, "film-id"), 0, 100);
    const [get] = toAna.splice(0);
    bob.receiveData(CINEMA, get.r, 0, FILM.subarray(0, 50));
    bob.receiveAnswer({ t: "ar-end", a: CINEMA, r: get.r, z: FILM.length });
    expect(await settled(read)).toEqual({ error: "failed" });
  });

  it("an error code this version does not know reads as failed", async () => {
    const { ana, bob, toAna } = pair({ hold: true });
    const read = bob.read(CINEMA, ana.serve(CINEMA, "film-id"), 0, 1);
    const [get] = toAna.splice(0);
    bob.receiveAnswer({ t: "ar-err", a: CINEMA, r: get.r, e: "too-late" });
    expect(await settled(read)).toEqual({ error: "failed" });
  });

  it("closing the app ends its serves, stops what it sends and fails what it asked", async () => {
    const { ana, bob, tasks, flush } = pair({ hold: true });
    const serve = ana.serve(CINEMA, "film-id"), chess = ana.serve(CHESS, "board");
    const reads = Array.from({ length: 5 }, () => bob.read(CINEMA, serve, 0, 1));
    const other = bob.read(CHESS, chess, 0, 1);
    flush();
    ana.closeApp(CINEMA);
    bob.closeApp(CINEMA);
    expect(tasks.filter(task => task.app === CINEMA).every(task => !task.live)).toBe(true);
    expect(ana.servesOf(CINEMA)).toEqual([]);
    for (const read of reads) expect(await settled(read)).toEqual({ error: "peer-closed" });
    // Chess goes on.
    expect(ana.servesOf(CHESS)).toEqual([chess]);
    const live = tasks.find(task => task.app === CHESS)!;
    expect(live.live).toBe(true);
    ana.finish(live, 0);
    flush();
    expect(await other).toEqual({ bytes: new Uint8Array(), size: 0 });
  });

  it("no serve id lasts into the next session, and every read fails offline", async () => {
    const { ana, bob, flush } = pair({ hold: true });
    const serve = ana.serve(CINEMA, "film-id");
    const reads = Array.from({ length: 5 }, () => bob.read(CINEMA, serve, 0, 1));
    flush();
    ana.reset();
    bob.reset();
    for (const read of reads) expect(await settled(read)).toEqual({ error: "offline" });
    expect(ana.servesOf(CINEMA)).toEqual([]);
    const next = bob.read(CINEMA, serve, 0, 1);
    flush();
    expect(await settled(next)).toEqual({ error: "not-served" });
  });

  it("refuses to ask for what no server would take", () => {
    const { bob } = pair();
    expect(() => bob.read(CINEMA, "short", 0, 1)).toThrow();
    expect(() => bob.read(CINEMA, toBase64Url(new Uint8Array(16)), 0, APP_RANGE_LIMITS.requestBytes + 1)).toThrow();
  });
});
