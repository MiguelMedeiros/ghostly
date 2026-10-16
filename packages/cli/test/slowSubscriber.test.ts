import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import type { GhostlyEvent } from "../src/events";
import { MAX_UNREAD, serve, type Host } from "../src/host";
// covers: headless.daemon

const root = mkdtempSync(join(tmpdir(), "gh-slow-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A hub with only what events.subscribe reads: its journal is `journal`, and `emit` gives every subscriber an event. */
function fakeHub(journal: GhostlyEvent[] = []) {
  const listeners = new Set<(event: GhostlyEvent) => void>();
  let seq = journal.at(-1)?.seq ?? 0;
  return {
    listeners,
    hub: {
      get lastSeq() { return seq; },
      replay: (since: number) => journal.filter((e) => e.seq > since),
      onEvent: (listener: (event: GhostlyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    emit: (text: string) => { const event = { seq: ++seq, id: `e${seq}`, type: "message.received", at: 0, text } as GhostlyEvent; for (const l of listeners) l(event); },
  };
}

async function served(name: string, hub: ReturnType<typeof fakeHub>["hub"]) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  const host = { ctx: { runtime: { paths: { dir, socket: join(dir, "daemon.sock") } }, hub } } as unknown as Host;
  const s = await serve(host);
  const sockets: Socket[] = [];
  s.server.on("connection", (socket) => sockets.push(socket));
  return { ...s, sockets, path: join(dir, "daemon.sock") };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const LONG = "x".repeat(64 * 1024);

describe.skipIf(process.platform === "win32")("a subscriber that stops reading", () => {
  it("costs the daemon MAX_UNREAD at most: past it the subscription ends, and what was sent before still arrives", async () => {
    const { hub, listeners, emit } = fakeHub();
    const s = await served("paused", hub);
    try {
      const client = connect(s.path);
      const seqs: number[] = [];
      const lines = createInterface({ input: client });
      const subscribed = new Promise<void>((resolve) => lines.on("line", (line) => {
        const message = JSON.parse(line) as { result?: unknown; event?: GhostlyEvent };
        if (message.result) resolve(); else if (message.event) seqs.push(message.event.seq);
      }));
      client.write(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }) + "\n");
      await subscribed;
      client.pause(); // what Ctrl+Z on `ghostly listen` does
      let most = 0;
      // 48 MB of events (a contact's 16,000-byte texts are ~20 KB each as events: this is ~2,400 of them).
      for (let i = 0; i < 768; i++) {
        emit(LONG);
        most = Math.max(most, s.sockets[0].writableLength);
        if (i % 16 === 0) await turn();
      }
      expect(listeners.size).toBe(0);
      expect(most).toBeLessThanOrEqual(MAX_UNREAD + LONG.length + 200);
      const closed = new Promise((resolve) => client.on("close", resolve));
      client.resume();
      await closed;
      // Everything the daemon wrote before it ended the connection, in order, from the first: `listen` goes on from the last.
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    } finally { await s.close(); }
  });

  it("a client that reads takes a replay larger than MAX_UNREAD and every live event after it", async () => {
    const journal = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, id: `e${i + 1}`, type: "message.received", at: 0, text: LONG }) as GhostlyEvent);
    const { hub, listeners, emit } = fakeHub(journal);
    const s = await served("reading", hub);
    try {
      const client = connect(s.path);
      const seqs: number[] = [];
      const lines = createInterface({ input: client });
      let got!: () => void;
      const all = new Promise<void>((resolve) => { got = resolve; });
      lines.on("line", (line) => {
        const message = JSON.parse(line) as { event?: GhostlyEvent };
        if (message.event) seqs.push(message.event.seq);
        if (seqs.length === 300) got();
      });
      client.write(JSON.stringify({ id: 1, method: "events.subscribe", params: { since: 0 } }) + "\n");
      while (listeners.size === 0) await turn();
      for (let i = 0; i < 100; i++) emit(LONG);
      await all;
      expect(seqs).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
      expect(listeners.size).toBe(1);
      client.destroy();
    } finally { await s.close(); }
  });
});
