import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { profilePaths, type ProfilePaths } from "../src/profiles";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.events, headless.daemon

/*
 * What a start reads of a long chat to know what to report (`openHost`, the daemon's and a one-shot command's own, in
 * this process, on a new profile and on this machine's network only). The whole history of every chat and group, read
 * at every start, grew a daemon's start and its memory with every message the profile ever stored.
 */
const root = mkdtempSync(join(tmpdir(), "ghostly-start-reads-"));
const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
const before: Record<string, string | undefined> = {};
const LONG = 150;

beforeAll(() => { for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; } });
afterAll(() => {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

// Within the seen set's 30 days (SEEN_KEEP_MS): a message that came longer ago with no note is no news.
const T0 = Date.now() - 10 * 86_400_000;
const row = (linkId: string, i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: T0 + i * 1000, via: "datalink" });

/** A process's life with the profile: the engine and the store are new each time, as after a restart. */
async function run<T>(paths: ProfilePaths, work: (host: import("../src/host").Host, tools: { db: typeof import("@ghostly/browser/engine/db").db; wholeReads: (chat: string) => number; reported: () => string[] }) => Promise<T>): Promise<T> {
  vi.resetModules();
  const { GhostlyNode } = await import("@ghostly/browser/engine/node");
  const whole = vi.spyOn(GhostlyNode.prototype, "getMessages");
  const { openHost } = await import("../src/host");
  const { db } = await import("@ghostly/browser/engine/db");
  const host = await openHost(paths, "one-shot", "test");
  // Every message event the profile ever reported, this start's included.
  const reported = () => host.ctx.hub.replay(0).filter((event) => event.type.startsWith("message.")).map((event) => event.id);
  try {
    return await work(host, { db, wholeReads: (chat) => whole.mock.calls.filter(([id]) => id === chat).length, reported });
  } finally { await host.close(); whole.mockRestore(); }
}

describe("what a start reads of a long chat", { timeout: 120_000 }, () => {
  it("its newest messages when the profile was closed in step, its whole history after a crash or with news in it", async () => {
    const paths = profilePaths(join(root, "home"), "long");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const { callApi } = await import("../src/api");

    // A chat, and a long history stored while no process derived events from it.
    const chat = await run(paths, async (host, { db }) => {
      const { chat } = (await callApi(host.ctx, "invite.create", { label: "long" })) as { chat: string };
      for (let i = 1; i <= LONG; i++) await db.putMessage(row(chat, i));
      return chat;
    });

    // News among its newest messages: the whole history is read, and all of it reported once.
    await run(paths, async (_host, { wholeReads, reported }) => {
      expect(wholeReads(chat)).toBe(1);
      expect(reported()).toHaveLength(LONG);
      expect(reported()).toContain(`message.received:${chat}:peer_1`);
    });

    // In step and closed: no whole history, and nothing reported again. A crash follows (the store is copied as it is
    // while open, journal and all), after a message that sorts before the newest ones was stored and not reported.
    const crashed = profilePaths(join(root, "home"), "crashed");
    await run(paths, async (_host, { db, wholeReads, reported }) => {
      expect(wholeReads(chat)).toBe(0);
      expect(reported()).toHaveLength(LONG);
      await db.putMessage(row(chat, 0));
      // The row's transaction ends a turn after its request answers: in the journal then.
      await new Promise((resolve) => setTimeout(resolve, 50));
      mkdirSync(crashed.dir, { recursive: true, mode: 0o700 });
      cpSync(paths.db, crashed.db, { recursive: true });
      cpSync(paths.events, crashed.events);
    });

    await run(crashed, async (_host, { wholeReads, reported }) => {
      expect(wholeReads(chat)).toBe(1);
      expect(reported()).toHaveLength(LONG + 1);
      expect(reported().at(-1)).toBe(`message.received:${chat}:peer_0`);
    });
  });
});
