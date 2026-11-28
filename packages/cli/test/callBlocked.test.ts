import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heardCallSignal } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi } from "../src/api";
import type { ApiContext } from "../src/apiKit";
import { CallManager } from "../src/calls/manager";
// covers: headless.calls

/**
 * `ghostly engine setContactBlocked` during a call: the engine drops every call signal of a blocked contact, their
 * hang-up too, so a call left on would ring here until it went stale, or never hear the end of a call that is on. The
 * call ends with the block, as the apps' Block contact ends it. No media: the stack is missing, and the calls only ring.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => { quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
afterEach(() => quiet.mockRestore());

const KEY = "o".repeat(52), OTHER = "y".repeat(52);

/** A daemon on two chats, one with each contact; the engine's `setContactBlocked` marks the contact's chat blocked. */
function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "gcblock-"));
  dirs.push(dir);
  const links: Partial<LinkView>[] = [
    { id: "chat-ana", peerPubKeyZ32: KEY, profile: "paired-chat/1", callsUnavailable: null, label: "ana" },
    { id: "chat-bob", peerPubKeyZ32: OTHER, profile: "paired-chat/1", callsUnavailable: null, label: "bob" },
  ];
  const state = () => ({ links, groups: [], settings: { iceServers: [] } }) as unknown as EngineState;
  const signals: { chat: string; signal: string | null }[] = [];
  const calls = new CallManager({
    engine: { getState: state, chatView: (id) => state().links.find((l) => l.id === id), getSettings: () => state().settings, setCallSignal: ({ linkId, signal }) => { signals.push({ chat: linkId, signal }); } },
    emit: () => {}, profileDir: dir, stack: async () => "no media in this test",
  });
  const node = {
    setContactBlocked: async ({ peerPubKeyZ32, blocked }: { peerPubKeyZ32: string; blocked: boolean }) => {
      for (const link of links) if (link.peerPubKeyZ32 === peerPubKeyZ32) link.blocked = blocked ? true : undefined;
    },
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default", dir } }, calls, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, calls, signals };
}

/** The contact's call ringing in `chat`: an offer as the engine hands it on. */
function ring(calls: CallManager, chat: string): void {
  const offer = { t: "o", ts: Date.now(), u: "ufra", p: "p".repeat(22), f: "ab".repeat(32), s: "actpass", c: [], v: 0 };
  calls.onSignal(chat, heardCallSignal(JSON.stringify(offer), Date.now()));
}

const block = (ctx: ApiContext, peerPubKeyZ32: string, blocked: boolean) =>
  callApi(ctx, "engine.call", { method: "setContactBlocked", params: { peerPubKeyZ32, blocked } });

describe("a contact blocked while its call rings here", () => {
  it("stops the ring with nothing sent to the contact, and leaves another contact's ringing", async () => {
    const { ctx, calls, signals } = daemon();
    ring(calls, "chat-ana");
    ring(calls, "chat-bob");
    expect(calls.list()).toMatchObject([{ chat: "chat-ana", state: "ringing" }, { chat: "chat-bob", state: "ringing" }]);
    await block(ctx, KEY, true);
    expect(calls.list()).toMatchObject([{ chat: "chat-bob", state: "ringing" }]);
    // No decline: as if this side were closed.
    expect(signals.filter(({ signal }) => signal && JSON.parse(signal).t === "h")).toEqual([]);
    await calls.stopAll();
  });
});
