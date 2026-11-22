import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.chat, headless.events

/**
 * `stage` (and `progress` in `chat show`) is the first pairing's, while it is under way. The engine keeps it at `live`
 * for the rest of the run once the pairing opened a session: after the contact's daemon stopped, `chat show` and
 * `chat list` read `"live":false` beside `"stage":"live"` until this daemon restarted, which reads `"stage":null`.
 */
const paired = { id: "chat-one", label: "bob", peerPubKeyZ32: "pbob", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", peerParticipationKey: "k" };
const progress = (stage: string) => ({ role: "joiner", stage, since: 5, startedAt: 1, attempt: 1, ...(stage === "live" ? { transport: "webrtc/1" } : {}) });
/** The session the pairing opened, up. */
const up = { textDelivery: "stream", dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } };
/** That session ended: the chat is back on the DHT, dialling again. */
const down = { textDelivery: "dht", dataLink: "closed", pairing: { status: "connecting" } };

function fake(fields: Record<string, unknown>): ApiContext {
  const link = { ...paired, ...fields } as unknown as LinkView;
  const node = { chatView: chatViewOf, getState: () => ({ links: [link], groups: [], settings: {}, transport: {} }) as unknown as EngineState };
  return { runtime: { server: { node }, paths: { name: "default", dir: "/nonexistent" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
}

const shown = async (fields: Record<string, unknown>) => {
  const ctx = fake(fields);
  const show = await callApi(ctx, "chat.get", { chat: "bob" }) as { live: boolean; stage: unknown; progress: unknown };
  const { chats } = await callApi(ctx, "chat.list", {}) as { chats: { stage: unknown }[] };
  return { live: show.live, stage: show.stage, progress: show.progress === null ? null : (show.progress as { stage: string }).stage, listed: chats[0]!.stage };
};

describe("a chat's pairing stage", () => {
  it("is null once the session the pairing opened ended, as after a restart, never live beside live: false", async () => {
    expect(await shown({ ...down, pairingProgress: progress("live") })).toEqual({ live: false, stage: null, progress: null, listed: null });
    // After a restart the engine keeps no progress for a paired chat: the same.
    expect(await shown({ ...down })).toEqual({ live: false, stage: null, progress: null, listed: null });
  });

  it("says live while that session is, and every stage of a pairing under way", async () => {
    expect(await shown({ ...up, pairingProgress: progress("live") })).toEqual({ live: true, stage: "live", progress: "live", listed: "live" });
    for (const stage of ["resolving", "knocking", "connecting", "on-dht", "failed"]) {
      expect(await shown({ ...down, peerParticipationKey: undefined, pairingProgress: progress(stage) })).toEqual({ live: false, stage, progress: stage, listed: stage });
    }
  });
});

describe("chat.pairing", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ghostly-stage-"));
    await openPersistentIndexedDb(join(dir, "db"));
  });

  it("is said once when the pairing goes live, not again when its session ends or a later one opens", async () => {
    const h = new EventHub(join(dir, "stage.jsonl"), () => 1000, "stage.jsonl");
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    const state = (fields: Record<string, unknown>) => ({ links: [{ ...paired, ...fields }], groups: [], settings: {}, transport: {} }) as unknown as EngineState;
    h.baseline(state({ ...down, pairingProgress: progress("connecting") }), new Map());
    for (const fields of [up, down, up]) h.sink.post({ kind: "state", state: state({ ...fields, pairingProgress: progress("live") }) });
    expect(events.filter((e) => e.type === "chat.pairing").map((e) => (e as unknown as { stage: string }).stage)).toEqual(["live"]);
    expect(events.filter((e) => e.type === "chat.connection").map((e) => (e as unknown as { live: boolean }).live)).toEqual([true, false, true]);
  });
});
