import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import type { GhostlyNode } from "@ghostly/browser/engine/node";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import type { ApiContext } from "../src/api";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
import { purgeMessage } from "../src/waits";
// covers: headless.chat

/**
 * `message delete --everyone --purge` in a group: a reply here that quotes the message keeps the first 120 characters
 * of what it said (`replyTo.snippet`) until the engine's quote sweep takes them out, at most once every 10 s per chat
 * (`QuoteSweeps`). The fold ran before that sweep, so a token deleted right after another one was still in the
 * profile's folder, in its quote, when the command answered `purged: true`. The engine's own, on the CLI's store.
 */
const SECRET = "sk-made-up-0123456789abcdef";

let dir: string;
let store: PersistentIndexedDb;
let node: GhostlyNode;
let db: typeof import("@ghostly/browser/engine/db").db;

/** The profile's db folder: the files that hold `text` (journal.bin, rows.db and its WAL). */
const holding = (text: string) => readdirSync(dir).filter((file) => readFileSync(join(dir, file)).includes(text));

describe("message delete --purge, a quoted message", () => {
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), "ghostly-purge-quotes-")), "db");
    // First: the engine's store opens on the global it installs.
    store = await openPersistentIndexedDb(dir);
    ({ db } = await import("@ghostly/browser/engine/db"));
    const { GhostlyNode } = await import("@ghostly/browser/engine/node");
    const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
    node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, { transport, automaticWallets: false });
  });
  afterAll(() => (node as unknown as { groupEdits: { stop(): void } }).groupEdits.stop());

  it("takes what it said out of the replies that quote it before the fold", async () => {
    const me = createIdentity().pubKeyZ32, bob = createIdentity().pubKeyZ32, g = `purge-${crypto.randomUUID()}`, chat = `group:${g}`;
    const inner = node as unknown as {
      groups: { setRemovals(groupId: string, list: unknown[]): Promise<void> };
      groupEdits: { host: { membership(groupId: string): unknown; send(...args: unknown[]): Promise<unknown> } };
    };
    vi.spyOn(inner.groups, "setRemovals").mockImplementation(async () => {});
    vi.spyOn(inner.groupEdits.host, "membership").mockReturnValue({ me, members: new Set([me, bob]), community: false, admin: true });
    vi.spyOn(inner.groupEdits.host, "send").mockImplementation(async () => null);
    const mine = (n: number, text: string): StoredMessage => ({ linkId: chat, id: `${me}:1:${n}`, text, sender: "me", member: me, timestamp: n, via: "datalink" });
    const reply = (n: number, to: StoredMessage): StoredMessage => ({ linkId: chat, id: `${bob}:1:${n}`, text: "saved it", sender: "peer", member: bob, timestamp: n, via: "datalink",
      replyTo: { id: to.id, snippet: to.text, from: "me", member: me } });
    const [first, second] = [mine(1, "an old note"), mine(3, `my token: ${SECRET}`)];
    for (const row of [first, reply(2, first), second, reply(4, second)]) await db.addMessage(row);
    expect(holding(SECRET)).not.toEqual([]);

    // A delete for everyone just before, as a bot cleaning up does: the next quote sweep of the group waits 10 s.
    expect(await node.removeMessage({ linkId: chat, messageId: first.id })).toMatchObject({ error: null });
    expect(await node.removeMessage({ linkId: chat, messageId: second.id })).toMatchObject({ error: null });
    await purgeMessage({ runtime: { server: { node }, store } } as unknown as ApiContext, chat, second.id);

    expect(holding(SECRET)).toEqual([]);
    expect((await db.getMessage(chat, `${bob}:1:4`))?.replyTo).toMatchObject({ id: second.id, snippet: "" });
  }, 30_000);
});
