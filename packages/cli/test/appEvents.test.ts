import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { reportAppFrames } from "../src/appEvents";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events

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

async function setup(journal: string, served: string[]) {
  const profile = mkdtempSync(join(tmpdir(), "ghostly-app-events-profile-"));
  const serve = (refs: string[]) => writeFileSync(join(profile, "apps.json"), JSON.stringify(refs.map((ref) => ({ ref }))));
  serve(served);
  const hub = new EventHub(join(dir, journal), () => 1000, journal);
  await hub.open();
  const events: GhostlyEvent[] = [];
  hub.onEvent((e) => events.push(e));
  reportAppFrames(hub, node, profile);
  const frame = (linkId: string, event: Record<string, unknown>) => hub.sink.post({ kind: "app-frame", linkId, event } as never);
  const seen = () => events.map(({ type, chat, app, version, data, offline }) => ({ type, chat, app, ...(version !== undefined && { version }), ...(data !== undefined && { data }), ...(offline !== undefined && { offline }) }));
  return { hub, events, frame, seen, serve };
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
    // In order, each with an id of its own: two equal frames are two events.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.map((e) => e.id)).size).toBe(5);
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
});
