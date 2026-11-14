import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { reportAppFrames } from "../src/appEvents";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events

/** Reads of a profile's `apps.json`, counted. */
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith("apps.json")) reads.count++;
    return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

/**
 * The frames of a contact's app, as events of the stream (WISP 1200 § A bot on the other side): only for an app the
 * profile serves, named by its reference, in the chat they came in.
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-app-events-"));
  await openPersistentIndexedDb(join(dir, "db"));
});

const KEY = "y".repeat(52);
const CHESS = `${KEY}/chess`, POLL = `${KEY}/poll`;
/** A stand-in for the engine's `appId`: an id per chat and reference, and no id for a chat that is not paired. */
const node = { appId: ({ linkId, ref }: { linkId: string; ref: string }) => { if (linkId === "unpaired") throw new Error("This chat is not paired yet"); return { app: `id:${linkId}:${ref.split("/")[1]}` }; } };

async function setup(journal: string, served: string[], ids: { appId(params: { linkId: string; ref: string }): { app: string } } = node) {
  const profile = mkdtempSync(join(tmpdir(), "ghostly-app-events-profile-"));
  const serve = (refs: string[]) => writeFileSync(join(profile, "apps.json"), JSON.stringify(refs.map((ref) => ({ ref }))));
  serve(served);
  const hub = new EventHub(join(dir, journal), () => 1000, journal);
  await hub.open();
  const events: GhostlyEvent[] = [];
  hub.onEvent((e) => events.push(e));
  reportAppFrames(hub, ids, profile);
  const frame = (linkId: string, event: Record<string, unknown>) => hub.sink.post({ kind: "app-frame", linkId, event } as never);
  const seen = () => events.map(({ type, chat, app, version, data, offline }) => ({ type, chat, app, ...(version !== undefined && { version }), ...(data !== undefined && { data }), ...(offline !== undefined && { offline }) }));
  return { hub, events, frame, seen, serve, profile };
}

describe("app events", () => {
  it("reports a served app opened, its frames and its close, by the app's reference", async () => {
    const { events, frame, seen } = await setup("served.jsonl", [CHESS]);
    frame("c1", { app: "id:c1:chess", o: "open", v: "2.3.0" });
    frame("c1", { app: "id:c1:chess", d: { p: "chess", v: 2, k: "hello" } });
    frame("c1", { app: "id:c1:chess", d: 0 });
    frame("c1", { app: "id:c1:chess", o: "close" });
    frame("c1", { app: "id:c1:chess", o: "close", offline: true });
    expect(seen()).toEqual([
      { type: "app.opened", chat: "c1", app: CHESS, version: "2.3.0" },
      { type: "app.message", chat: "c1", app: CHESS, data: { p: "chess", v: 2, k: "hello" } },
      { type: "app.message", chat: "c1", app: CHESS, data: 0 },
      { type: "app.closed", chat: "c1", app: CHESS },
      { type: "app.closed", chat: "c1", app: CHESS, offline: true },
    ]);
    // In order, each with an id of its own: two equal frames are two events. Live only, they take no seq of their own.
    expect(events.map((e) => e.seq)).toEqual([0, 0, 0, 0, 0]);
    expect(new Set(events.map((e) => e.id)).size).toBe(5);
  });

  it("keeps the frames out of the journal: a contact's app at the receiver's rate never evicts another chat's texts", async () => {
    const { hub, events, frame } = await setup("flood.jsonl", [CHESS]);
    hub.emit("message.received", "message.received:c2:m1", { chat: "c2", message: { id: "m1", text: "hello" } });
    frame("c1", { app: "id:c1:chess", o: "open", v: "2.3.0" });
    // About 20 s of frames at 50/s, each near the receiver's 32 KiB: past the journal's byte cap twice over before.
    const data = "x".repeat(32 * 1024 - 64);
    for (let i = 0; i < 1100; i++) frame("c1", { app: "id:c1:chess", d: { i, data } });
    frame("c1", { app: "id:c1:chess", o: "close" });
    hub.emit("message.received", "message.received:c2:m2", { chat: "c2", message: { id: "m2", text: "still here" } });
    // A replay gives the texts, whole and with no gap, and none of the frames: they are live only (WISP 1200).
    expect(hub.replay(0).map((e) => [e.seq, e.type])).toEqual([[1, "message.received"], [2, "message.received"]]);
    expect(hub.replay(1).map((e) => e.id)).toEqual(["message.received:c2:m2"]);
    expect(hub.lastSeq).toBe(2);
    // Each frame reached the stream as it came, with the seq of the event before it: a cursor that handled one resumes
    // after that event.
    expect(events.filter((e) => e.type === "app.message")).toHaveLength(1100);
    expect(events.filter((e) => e.type.startsWith("app.")).every((e) => e.seq === 1)).toBe(true);
    expect(events.at(-1)?.seq).toBe(2);
  });

  it("reports nothing of an app the profile does not serve, nor of another chat's id", async () => {
    const { frame, seen } = await setup("unserved.jsonl", [CHESS]);
    frame("c1", { app: "id:c1:poll", o: "open", v: "1.0.0" });
    frame("c1", { app: "id:c1:poll", d: { vote: 1 } });
    // The same app's id in another chat names nothing in this one.
    frame("c1", { app: "id:c2:chess", o: "open", v: "2.3.0" });
    frame("unpaired", { app: "id:unpaired:chess", o: "open", v: "2.3.0" });
    expect(seen()).toEqual([]);
  });

  it("with no app served, reports nothing", async () => {
    const { frame, seen } = await setup("none.jsonl", []);
    frame("c1", { app: "id:c1:chess", o: "open", v: "2.3.0" });
    frame("c1", { app: "id:c1:chess", d: 1 });
    expect(seen()).toEqual([]);
  });

  it("takes an app served since, and leaves one unserved since, from its next open", async () => {
    const { frame, seen, serve } = await setup("changed.jsonl", [CHESS]);
    frame("c1", { app: "id:c1:chess", o: "open", v: "2.3.0" });
    serve([POLL]);
    frame("c1", { app: "id:c1:poll", o: "open", v: "1.0.0" });
    frame("c1", { app: "id:c1:chess", d: "after unserve" });
    frame("c1", { app: "id:c1:chess", o: "open", v: "2.3.0" });
    expect(seen()).toEqual([
      { type: "app.opened", chat: "c1", app: CHESS, version: "2.3.0" },
      { type: "app.opened", chat: "c1", app: POLL, version: "1.0.0" },
    ]);
  });

  describe("a contact repeating opens", () => {
    /** Served apps by name, and the engine's stand-in counting the chat app ids it derives (each a hash and an HMAC). */
    const NAMES = ["a", "b", "c", "d", "e"];
    async function counted(journal: string) {
      let derived = 0;
      const ids = { appId: (params: { linkId: string; ref: string }) => { derived++; return node.appId(params); } };
      const setupDone = await setup(journal, NAMES.map((n) => `${KEY}/${n}`), ids);
      reads.count = 0;
      return { ...setupDone, derived: () => derived };
    }

    it("reads the served apps and derives their ids once, not at every repeated open", async () => {
      const { events, frame, derived } = await counted("repeat.jsonl");
      // 800 opens: each served app and an app not served here, again and again at the same version.
      for (let i = 0; i < 800; i++) frame("c1", { app: `id:c1:${[...NAMES, "unserved"][i % 6]}`, o: "open", v: "1.0.0" });
      expect(derived()).toBe(NAMES.length);
      expect(reads.count).toBe(1);
      // Every open of a served app is still reported.
      expect(events.filter((e) => e.type === "app.opened")).toHaveLength(800 - Math.ceil((800 - 5) / 6));
      // Another chat learns its own ids, once too.
      for (let i = 0; i < 10; i++) frame("c2", { app: "id:c2:a", o: "open", v: "1.0.0" });
      expect(derived()).toBe(2 * NAMES.length);
      expect(reads.count).toBe(2);
    });

    it("learns again once apps.json changed: an app served since is taken from its next open", async () => {
      const { frame, seen, serve, profile, derived } = await counted("reserved.jsonl");
      frame("c1", { app: "id:c1:a", o: "open", v: "1.0.0" });
      frame("c1", { app: "id:c1:poll", o: "open", v: "1.0.0" });
      expect(derived()).toBe(NAMES.length);
      // Another process (a one-shot `app serve`) writes the file: the daemon learns it at the next open.
      serve([...NAMES.map((n) => `${KEY}/${n}`), POLL]);
      utimesSync(join(profile, "apps.json"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      frame("c1", { app: "id:c1:poll", o: "open", v: "1.0.0" });
      frame("c1", { app: "id:c1:poll", o: "open", v: "1.0.0" });
      expect(derived()).toBe(NAMES.length + NAMES.length + 1);
      expect(reads.count).toBe(2);
      expect(seen()).toEqual([
        { type: "app.opened", chat: "c1", app: `${KEY}/a`, version: "1.0.0" },
        { type: "app.opened", chat: "c1", app: POLL, version: "1.0.0" },
        { type: "app.opened", chat: "c1", app: POLL, version: "1.0.0" },
      ]);
    });

    it("learns nothing again when opens alternate versions: the ids do not depend on one", async () => {
      const { events, frame, derived } = await counted("version.jsonl");
      for (let i = 0; i < 400; i++) frame("c1", { app: `id:c1:${NAMES[i % NAMES.length]}`, o: "open", v: i % 2 ? "1.1.0" : "1.0.0" });
      expect(derived()).toBe(NAMES.length);
      expect(reads.count).toBe(1);
      expect(events.filter((e) => e.type === "app.opened").map((e) => e.version).slice(0, 2)).toEqual(["1.0.0", "1.1.0"]);
    });
  });
});
