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

interface Tools {
  db: typeof import("@ghostly/browser/engine/db").db;
  wholeReads: (chat: string) => number;
  /** The newest pages the host read itself (`messagePage`). */
  pageReads: (chat: string) => number;
  reported: () => string[];
  /** How many times the hub read its seen set (`EventHub.loadSeen`). */
  seenReads: () => number;
}

/**
 * A process's life with the profile: the engine and the store are new each time, as after a restart. `reread`: the
 * host reads each newest page itself, as it did before the engine handed it the rows its start read.
 */
async function run<T>(paths: ProfilePaths, work: (host: import("../src/host").Host, tools: Tools) => Promise<T>, reread = false, options: import("../src/runtime/engine").RuntimeOptions = {}): Promise<T> {
  vi.resetModules();
  const { GhostlyNode } = await import("@ghostly/browser/engine/node");
  const whole = vi.spyOn(GhostlyNode.prototype, "getMessages");
  const page = vi.spyOn(GhostlyNode.prototype, "messagePage");
  const { EngineServer } = await import("@ghostly/browser/engine/server");
  const handed = reread ? vi.spyOn(EngineServer.prototype, "takeStartNewest").mockReturnValue(new Map()) : null;
  const { EventHub } = await import("../src/events");
  const seen = vi.spyOn(EventHub.prototype, "loadSeen");
  const { openHost } = await import("../src/host");
  const { db } = await import("@ghostly/browser/engine/db");
  const host = await openHost(paths, "one-shot", "test", options);
  // Every message event the profile ever reported, this start's included.
  const reported = () => host.ctx.hub.replay(0).filter((event) => event.type.startsWith("message.")).map((event) => event.id);
  const calls = (spy: typeof whole | typeof page, chat: string) => spy.mock.calls.filter(([id]) => (typeof id === "string" ? id : id.linkId) === chat).length;
  try {
    return await work(host, { db, wholeReads: (chat) => calls(whole, chat), pageReads: (chat) => calls(page, chat), reported, seenReads: () => seen.mock.calls.length });
  } finally { await host.close(); whole.mockRestore(); page.mockRestore(); handed?.mockRestore(); seen.mockRestore(); }
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

  it("its newest messages from what the engine's start read: no page read again, the same events as reading it", async () => {
    const home = join(root, "handed");
    const paths = profilePaths(home, "base");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const { callApi } = await import("../src/api");
    const member = (linkId: string, i: number): StoredMessage => ({ ...row(linkId, i), id: `member_${i}`, member: "ab".repeat(32) });

    // A chat and a community, each with a long history, then a start that reports all of it and closes in step.
    const { chat, group } = await run(paths, async (host, { db }) => {
      const { chat } = (await callApi(host.ctx, "invite.create", { label: "long" })) as { chat: string };
      const group = `group:${((await callApi(host.ctx, "group.create", { name: "long" })) as { group: string }).group}`;
      for (let i = 1; i <= LONG; i++) { await db.putMessage(row(chat, i)); await db.putMessage(member(group, i)); }
      return { chat, group };
    });
    await run(paths, async (host, { reported }) => {
      expect(reported()).toHaveLength(LONG);
      expect(host.ctx.hub.replay(0).filter((event) => event.type === "group.message")).toHaveLength(LONG);
    });

    // Each case on a copy of the profile as closed, started twice: as now, and reading the newest pages itself.
    const cases: [string, (db: Tools["db"]) => Promise<void>, number][] = [
      ["closed in step", async () => {}, 0],
      ["a message no start reported, among the newest", async (db) => { await db.putMessage(row(chat, LONG + 1)); await db.putMessage(member(group, LONG + 1)); }, 1],
      ["a message no start reported, past the newest 100", async (db) => { await db.putMessage(row(chat, -1)); await db.putMessage(member(group, -1)); }, 0],
    ];
    for (const [name, change, whole] of cases) {
      await run(paths, async (_host, { db }) => {
        await change(db);
        // The rows' transactions end a turn after their requests answer.
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const starts: { events: string; pages: number[]; wholes: number }[] = [];
      for (const reread of [false, true]) {
        const copy = profilePaths(home, `${name.replaceAll(/\W+/g, "-")}-${reread ? "reread" : "handed"}`);
        mkdirSync(copy.dir, { recursive: true, mode: 0o700 });
        cpSync(paths.db, copy.db, { recursive: true });
        cpSync(paths.events, copy.events);
        starts.push(await run(copy, async (host, { pageReads, wholeReads }) => ({
          // When each event was made is this start's clock.
          events: host.ctx.hub.replay(0).map(({ at: _at, ...event }) => JSON.stringify(event)).join("\n"),
          pages: [pageReads(chat), pageReads(group)],
          wholes: wholeReads(chat),
        }), reread));
      }
      const [handed, reread] = starts;
      expect(handed!.pages, name).toEqual([0, 0]);
      expect(reread!.pages, name).toEqual([1, 1]);
      expect([handed!.wholes, reread!.wholes], name).toEqual([whole, whole]);
      expect(handed!.events, name).toBe(reread!.events);
    }
  });

  it("an offline one-shot reads neither the seen set nor a history while nothing changes there; a change reads them then", async () => {
    const paths = profilePaths(join(root, "offline"), "offline");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const { callApi } = await import("../src/api");
    const chat = await run(paths, async (host, { db }) => {
      const { chat } = (await callApi(host.ctx, "invite.create", { label: "long" })) as { chat: string };
      for (let i = 1; i <= LONG; i++) await db.putMessage(row(chat, i));
      return chat;
    });
    await run(paths, async (_host, { reported }) => { expect(reported()).toHaveLength(LONG); });

    // A read (`status`, `chat list`): the seen set, a note per message of the last 30 days, took 0.16 s and 56 MB at 50,000.
    await run(paths, async (host, { seenReads, wholeReads, pageReads }) => {
      await callApi(host.ctx, "chat.list", {});
      expect([seenReads(), wholeReads(chat), pageReads(chat)]).toEqual([0, 0, 0]);
    }, false, { offline: true });

    // A row no start reported, past the newest 100, then a message deleted here: its history changed while the one-shot
    // ran, so the seen set is read then and the history whole, and both are told.
    await run(paths, async (host, { db, seenReads, wholeReads, reported }) => {
      await db.putMessage(row(chat, 0));
      host.ctx.runtime.server.node.deleteMessage({ linkId: chat, messageId: `peer_${LONG}` });
      // The row goes a turn later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await host.close();
      expect([seenReads(), wholeReads(chat)]).toEqual([1, 1]);
      expect(reported().slice(-2).sort()).toEqual([`message.deleted:${chat}:peer_${LONG}`, `message.received:${chat}:peer_0`]);
    }, false, { offline: true });
  });

  it("a file of a message past its newest: only the history's file rows are read to name it, never the whole history", async () => {
    const paths = profilePaths(join(root, "files"), "files");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const { callApi } = await import("../src/api");
    const file = (id: string) => ({ id, name: "a.txt", size: 9, mime: "text/plain" });
    const { chat, group } = await run(paths, async (host, { db }) => {
      const { chat } = (await callApi(host.ctx, "invite.create", { label: "files" })) as { chat: string };
      const group = (await callApi(host.ctx, "group.create", { name: "files" })) as { group: string };
      for (let i = 1; i <= LONG; i++) {
        await db.putMessage({ ...row(chat, i), ...(i === 1 ? { file: file(`${chat}-in-old`) } : {}) });
        await db.putMessage({ ...row(`group:${group.group}`, i), id: `member_${i}`, member: "ab".repeat(32), ...(i === 1 ? { file: file(`group-${group.group}-old`) } : {}) });
      }
      return { chat, group: group.group };
    });
    await run(paths, async () => {});

    // Closed in step: the next start reads the newest 100 of each. A contact's file of the oldest message then ends.
    await run(paths, async (host, { wholeReads }) => {
      const { GhostlyNode } = await import("@ghostly/browser/engine/node");
      const groupWhole = vi.spyOn(GhostlyNode.prototype, "groupMessages");
      try {
        const done = { state: "done", transferred: 9, size: 9, direction: "in" };
        const state = host.ctx.runtime.server.node.getState();
        host.ctx.hub.sink.post({ kind: "state", state: { ...state, transfers: { [`${chat}-in-old`]: done, [`group-${group}-old`]: done } } as typeof state });
        const ends = () => host.ctx.hub.replay(0).filter((event) => event.type === "file.done").map((event) => [event.file, event.messageId]);
        await vi.waitFor(() => expect(ends()).toEqual([[`${chat}-in-old`, "peer_1"], [`group-${group}-old`, "member_1"]]));
        expect(wholeReads(chat)).toBe(0);
        expect(groupWhole).not.toHaveBeenCalled();
      } finally { groupWhole.mockRestore(); }
    });
  });
});
