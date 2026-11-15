import type { Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: headless.chat

/** The profile's rows.db, under its home. */
const ROWS = "profiles/default/db/rows.db";

/**
 * `message delete --purge` answered `purged: true` while a reply to the message (mine or the contact's) still held a
 * line of it in rows.db: history showed the quote as deleted, the reply's row kept its snippet. And two deletes for
 * everyone in a chat within 10 s left the second's quotes to a sweep after the answer.
 */
describe("message delete --purge and the replies that quote it", { timeout: 240_000 }, () => {
  let relays: { url: string; server: Server }[] = [];
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];
  const alice = home("purge-quotes-alice"), bob = home("purge-quotes-bob");
  const as = (dir: string, ...args: string[]): Promise<Result> => ghostly(["--home", dir, ...args], { env });
  const daemon = async (dir: string): Promise<void> => {
    const started = new Running(["--home", dir, "daemon"], env);
    running.push(started);
    await started.waitFor((line) => line.daemon === "ready");
  };
  /** Every file of the profile's folder that holds `secret`. */
  const holding = (dir: string, secret: string): string[] => {
    const out: string[] = [];
    const walk = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name), stat = statSync(path, { throwIfNoEntry: false });
        if (stat?.isDirectory()) walk(path);
        else if (stat?.isFile() && readFileSync(path).includes(secret)) out.push(path.slice(dir.length));
      }
    };
    walk(join(dir, "profiles"));
    return out;
  };
  /** The pages of a file (1-based, of `pageSize` bytes) that hold `secret`. */
  const pagesHolding = (bytes: Buffer, secret: string, pageSize: number): number[] => {
    const pages = new Set<number>();
    for (let at = bytes.indexOf(secret); at >= 0; at = bytes.indexOf(secret, at + 1)) pages.add(Math.floor(at / pageSize) + 1);
    return [...pages];
  };
  /** How many frames rows.db's WAL holds of each page: those of its current run only (their salts are the header's). */
  const walFrames = (wal: Buffer | null): Map<number, number> => {
    const frames = new Map<number, number>();
    if (!wal || wal.length < 32) return frames;
    const pageSize = wal.readUInt32BE(8), salts = [wal.readUInt32BE(16), wal.readUInt32BE(20)];
    for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) {
      if (wal.readUInt32BE(at + 8) !== salts[0] || wal.readUInt32BE(at + 12) !== salts[1]) break;
      frames.set(wal.readUInt32BE(at), (frames.get(wal.readUInt32BE(at)) ?? 0) + 1);
    }
    return frames;
  };
  /**
   * Where the profile's rows.db holds `secret`, said when a find fails the test. The test reads the file's bytes while the
   * daemon has it open in WAL mode, and a reader sees it merged with its WAL; so each page of the file that holds it says
   * whether the WAL has a newer copy of it (a write after the last checkpoint) and what it is to the reader (`dbstat`,
   * where this Node has it: a tree's page, or free). Then the rows that hold it (their store, id and fields), and whether
   * the file still holds it after a checkpoint from here: gone, the page was stale (the daemon's checkpoint stopped at a
   * reader, or a row that held it was checkpointed and deleted after); still there, it is in a page's free space.
   */
  const rowsHolding = async (dir: string, secret: string): Promise<string> => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(dir, ROWS), bytes = readFileSync(path);
    const pageSize = bytes.readUInt16BE(16) === 1 ? 65_536 : bytes.readUInt16BE(16);
    const wal = statSync(`${path}-wal`, { throwIfNoEntry: false }) ? readFileSync(`${path}-wal`) : null;
    const frames = walFrames(wal), pages = pagesHolding(bytes, secret, pageSize);
    const said: string[] = [], found: string[] = [];
    const file = new DatabaseSync(path, { readOnly: true });
    try {
      const count = (file.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      const free = (file.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
      let trees: Map<number, string> | null = null;
      try { trees = new Map((file.prepare("SELECT pageno, name FROM dbstat").all() as { pageno: number; name: string }[]).map((row) => [Number(row.pageno), row.name])); } catch { /* no dbstat in this Node's SQLite */ }
      const page = (n: number) => `${n} (${frames.get(n) ?? 0} in the WAL${n > count ? ", past the end" : ""}${trees ? `, ${trees.get(n) ?? "free"}` : ""})`;
      said.push(`rows.db pages holding it: ${pages.map(page).join(", ")} of ${count} (${pageSize} bytes each, ${free} free); WAL ${wal ? `${wal.length} bytes, ${[...frames.values()].reduce((a, b) => a + b, 0)} frames` : "none"}`);
      const rows = file.prepare("SELECT t.store, t.idx, e.key, e.value FROM entries e JOIN trees t ON e.tree = t.id").all() as { store: string; idx: string; key: Uint8Array; value: Uint8Array }[];
      found.push(...rows.filter((row) => Buffer.from(row.value).includes(secret)).map((row) => {
        const value = deserialize(row.value) as Record<string, unknown>;
        const fields = Object.entries(value).filter(([, field]) => JSON.stringify(field)?.includes(secret));
        return `${row.store}${row.idx && `/${row.idx}`} ${JSON.stringify(deserialize(row.key))} (delivery ${String(value.delivery)}): ${fields.map(([name, field]) => `${name} ${JSON.stringify(field)}`).join(", ")}`;
      }));
      said.push(found.length ? `rows holding it: ${found.join("; ")}` : "no row holds it");
    } finally { file.close(); }
    const writer = new DatabaseSync(path);
    try {
      const { busy } = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      const left = pagesHolding(readFileSync(path), secret, pageSize);
      const why = busy ? "the checkpoint stopped at a reader" : found.length ? "a row holds it" : "a page's free space";
      said.push(`after a checkpoint from here: ${left.length ? `still in pages ${left.join(", ")}: ${why}` : "gone: the page was stale"}`);
    } finally { writer.close(); }
    return said.join("; ");
  };
  const quotes = async (dir: string, chat: string) => (ok(await as(dir, "chat", "history", chat)).messages as { replyTo?: { snippet: string } }[]).filter((m) => m.replyTo).map((m) => m.replyTo!.snippet);

  beforeAll(async () => {
    relays = await Promise.all([localRelay(), localRelay()]);
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
    for (const dir of [alice, bob]) ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    await daemon(alice);
    await daemon(bob);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    ok(await as(bob, "invite", "join", invite.invite as string, "--label", "alice"));
    ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
  }, 150_000);

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    for (const relay of relays) relay.server.close();
  }, 30_000);

  it("a contact's message: my reply's and the contact's reply's quotes go with it", async () => {
    const secret = "sk-made-up-quoted-0123456789";
    const sent = ok(await as(alice, "send", "bob", `the token: ${secret}`, "--wait", "delivered")).messageId as string;
    ok(await as(alice, "send", "bob", "use that one", "--reply", sent, "--wait", "delivered"));
    const history = ok(await as(bob, "chat", "history", "alice")).messages as { id: string; text?: string }[];
    const received = history.find((m) => m.text?.includes(secret))!.id;
    ok(await as(bob, "send", "alice", "got it", "--reply", received, "--wait", "delivered"));
    expect(await quotes(bob, "alice")).toEqual([`the token: ${secret}`, `the token: ${secret}`]);

    expect(ok(await as(bob, "message", "delete", "alice", received, "--purge"))).toMatchObject({ deleted: received, purged: true });
    expect(holding(bob, secret)).toEqual([]);
    expect(await quotes(bob, "alice")).toEqual(["", ""]);
  });

  it("two of mine deleted for everyone back to back: neither's line stays in a reply", async () => {
    const secrets = ["sk-made-up-first-0123456789", "sk-made-up-second-0123456789"];
    const ids: string[] = [];
    for (const secret of secrets) {
      const id = ok(await as(alice, "send", "bob", `oops: ${secret}`, "--wait", "delivered")).messageId as string;
      ok(await as(alice, "send", "bob", "ignore that", "--reply", id, "--wait", "delivered"));
      ids.push(id);
    }
    for (const id of ids) expect(ok(await as(alice, "message", "delete", "bob", id, "--everyone", "--wait", "confirmed", "--purge"))).toMatchObject({ deleted: id, purged: true });
    for (const secret of secrets) {
      const files = holding(alice, secret);
      expect(files, files.includes(`/${ROWS}`) ? await rowsHolding(alice, secret) : undefined).toEqual([]);
    }
  });
});
