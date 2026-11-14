import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { profilePaths, type ProfilePaths } from "../src/profiles";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.chat

/*
 * `message delete --purge` on the engine and the store a daemon runs (`openHost`, this machine only): a reply that
 * quotes the deleted message keeps a line of it (`replyTo.snippet`), which the apps no longer show ("Original message
 * deleted"). Deleted here, that line stayed in rows.db for good; deleted for everyone, until the quotes' sweep, up to
 * 10 s after a removal before it in the chat, then until rows.db's next checkpoint. Either way `purged: true` answered
 * while the text was still in the profile's folder.
 */
const SECRET = "sk-made-up-0123456789abcdef";
const root = mkdtempSync(join(tmpdir(), "ghostly-purge-quotes-"));
const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
const before: Record<string, string | undefined> = {};

beforeAll(() => { for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; } });
afterAll(() => {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

const filesIn = (dir: string): string[] => readdirSync(dir).flatMap((name) => statSync(join(dir, name)).isDirectory() ? filesIn(join(dir, name)) : [join(dir, name)]);
/** The profile's files that hold the secret: its store (journal.bin, rows.db and its WAL), its event journal, any other. */
const holding = (paths: ProfilePaths, secret = SECRET) => filesIn(paths.dir).filter((file) => readFileSync(file).includes(secret)).map((file) => relative(paths.dir, file));

async function withHost(name: string, work: (tools: {
  paths: ProfilePaths; chat: string; call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  put: (message: StoredMessage) => Promise<void>; rows: () => Promise<StoredMessage[]>;
}) => Promise<void>): Promise<void> {
  const paths = profilePaths(join(root, "home"), name);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  vi.resetModules();
  const { openHost } = await import("../src/host");
  const { callApi } = await import("../src/api");
  const { db } = await import("@ghostly/browser/engine/db");
  const host = await openHost(paths, "daemon", "test", {});
  const call = (method: string, params: Record<string, unknown>) => callApi(host.ctx, method, params);
  // Stored as the engine stores what comes and what is sent, and told as it tells them (the event journal has them too).
  const node = host.ctx.runtime.server.node as unknown as { messagesChanged(chat: string, ids: string[]): Promise<void> };
  try {
    const { chat } = (await call("invite.create", { label: "Alice" })) as { chat: string };
    const put = async (message: StoredMessage) => { await db.putMessage({ ...message, linkId: chat }); await node.messagesChanged(chat, [message.id]); };
    await work({ paths, chat, call, put, rows: () => host.ctx.runtime.server.node.getMessages(chat) });
  } finally { await host.close(); }
}

const T0 = Date.now() - 60_000;

describe("message delete --purge and the replies that quote it", { timeout: 60_000 }, () => {
  it("deleted here: my reply's quote of it leaves the profile's folder before the answer", async () => {
    await withHost("here", async ({ paths, chat, call, put, rows }) => {
      await put({ linkId: chat, id: "peer_1", text: `the token: ${SECRET}`, sender: "peer", timestamp: T0, via: "datalink" });
      await put({ linkId: chat, id: `me_${T0 + 5}`, text: "got it", sender: "me", timestamp: T0 + 5, via: "datalink", delivery: "delivered",
        replyTo: { id: "W".repeat(22), snippet: `the token: ${SECRET}`, from: "peer", messageId: "peer_1" } });

      expect(await call("chat.delete", { chat, message: "peer_1", purge: true })).toMatchObject({ messageId: "peer_1", everyone: false, purged: true });
      expect(holding(paths)).toEqual([]);
      // What the apps show of it already: "Original message deleted".
      expect((await rows()).map((m) => m.replyTo)).toEqual([{ id: "W".repeat(22), snippet: "", from: "peer", messageId: "peer_1" }]);
      expect(((await call("chat.history", { chat })) as { messages: { replyTo?: unknown }[] }).messages[0]!.replyTo).toEqual({ id: "peer_1", snippet: "", from: "peer", found: false, deleted: true });
    });
  });

  it("deleted for everyone, twice in a row: the contact's quotes of each leave it before each answer", async () => {
    await withHost("everyone", async ({ paths, chat, call, put }) => {
      const secret = (i: number) => `${SECRET}-${i}`;
      for (const i of [1, 2]) {
        const wire = String(i).repeat(22);
        await put({ linkId: chat, id: `me_${T0 + i}`, text: `token: ${secret(i)}`, sender: "me", timestamp: T0 + i, via: "datalink", delivery: "delivered", wireId: wire });
        await put({ linkId: chat, id: `peer_${i}`, text: "ok", sender: "peer", timestamp: T0 + 10 + i, via: "datalink",
          replyTo: { id: wire, snippet: `token: ${secret(i)}`, from: "me", messageId: `me_${T0 + i}` } });
      }
      // The second within the quotes' sweep's 10 s of the first (`QUOTE_SWEEP_MS`).
      for (const i of [1, 2]) {
        expect(await call("chat.delete", { chat, message: `me_${T0 + i}`, everyone: true, wait: "none", purge: true })).toMatchObject({ everyone: true, purged: true });
        expect(holding(paths, secret(i)), `after the delete of ${i}`).toEqual([]);
      }
      expect(holding(paths)).toEqual([]);
    });
  });
});
