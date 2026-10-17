import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import type { GhostlyEvent } from "../src/events";
import { serve, type Host } from "../src/host";
import { followDaemon, MAX_BEHIND, type EventHandler } from "../src/listen";
// covers: headless.daemon

const root = mkdtempSync(join(tmpdir(), "gh-catchup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A hub whose journal holds `count` events; it counts its replays and the events they gave. */
function countingHub(count: number) {
  const event = (seq: number, text = "hi") => ({ seq, id: `e${seq}`, type: "message.received", at: 0, text }) as GhostlyEvent;
  const journal = Array.from({ length: count }, (_, i) => event(i + 1));
  const listeners = new Set<(event: GhostlyEvent) => void>();
  const counted = { replays: 0, replayed: 0 };
  return {
    counted,
    listeners,
    hub: {
      get lastSeq() { return journal.at(-1)?.seq ?? 0; },
      replay: (since: number) => { const events = journal.filter((e) => e.seq > since); counted.replays++; counted.replayed += events.length; return events; },
      onEvent: (listener: (event: GhostlyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    /** A new event: in the journal, and to every subscriber. */
    emit: (text: string) => { const next = event(journal.length + 1, text); journal.push(next); for (const l of listeners) l(next); },
  };
}

/** A hook that handles each event one turn after the one before (`step`): slow enough for the feed to fall behind. */
function slowHandler(gate: Promise<void> = Promise.resolve(), step: (done: () => void) => void = setImmediate) {
  const seqs: number[] = [];
  let chain = gate, behind = 0;
  const handle = (event: GhostlyEvent) => {
    behind++;
    chain = chain.then(() => new Promise<void>((resolve) => step(resolve))).then(() => { seqs.push(event.seq); behind--; });
  };
  return { seqs, handle: Object.assign(handle, { behind: () => behind, idle: () => chain }) as EventHandler };
}

async function served(name: string, hub: ReturnType<typeof countingHub>["hub"]) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  const s = await serve({ ctx: { runtime: { paths: { dir, socket: join(dir, "daemon.sock") } }, hub } } as unknown as Host);
  return { ...s, address: { dir, socket: join(dir, "daemon.sock") } };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe.skipIf(process.platform === "win32")("a listen attached to the daemon that falls behind", () => {
  it("catches up a 5,000-event backlog with one read of the journal, each event sent once", async () => {
    const backlog = 5 * MAX_BEHIND;
    const { hub, counted } = countingHub(backlog);
    const s = await served("backlog", hub);
    try {
      const client = await connectDaemon(s.address);
      const { seqs, handle } = slowHandler();
      const following = followDaemon(s.address, client!, handle, 0);
      await following.subscribed;
      await expect.poll(() => seqs.length, { timeout: 20_000 }).toBe(backlog);
      expect(seqs).toEqual(Array.from({ length: backlog }, (_, i) => i + 1));
      // Before: one replay per pause (5) and about 15,000 events written, most of them thrown away with the connection.
      expect(counted).toEqual({ replays: 1, replayed: backlog });
      following.close();
    } finally { await s.close(); }
  });

  it("a hook that is slow but still takes events keeps the connection past PAUSE_HOLD_MS: still one read of the journal", async () => {
    const backlog = 2 * MAX_BEHIND;
    const { hub, counted } = countingHub(backlog);
    const s = await served("slow", hub);
    try {
      const client = await connectDaemon(s.address);
      // About 1 ms an event: each pause lasts a second or more, ten times the hold.
      const { seqs, handle } = slowHandler(undefined, (done) => setTimeout(done, 1));
      const following = followDaemon(s.address, client!, handle, 0, 100);
      await following.subscribed;
      await expect.poll(() => seqs.length, { timeout: 30_000 }).toBe(backlog);
      expect(seqs).toEqual(Array.from({ length: backlog }, (_, i) => i + 1));
      expect(counted).toEqual({ replays: 1, replayed: backlog });
      following.close();
    } finally { await s.close(); }
  });

  it("a feed held while the daemon ends the connection goes on from the last event taken, each event once", async () => {
    const { hub, counted, listeners, emit } = countingHub(2 * MAX_BEHIND);
    const s = await served("ended", hub);
    try {
      const client = await connectDaemon(s.address);
      let open!: () => void;
      const { seqs, handle } = slowHandler(new Promise<void>((resolve) => { open = resolve; }));
      const following = followDaemon(s.address, client!, handle, 0);
      await following.subscribed;
      // The hook hangs; meanwhile more than the daemon lets a client leave unread comes live (16 MB).
      while (handle.behind() < MAX_BEHIND) await turn();
      for (let i = 0; i < 256; i++) { emit("x".repeat(64 * 1024)); if (i % 16 === 0) await turn(); }
      expect(listeners.size).toBe(0);
      open();
      const total = 2 * MAX_BEHIND + 256;
      await expect.poll(() => seqs.length, { timeout: 20_000 }).toBe(total);
      expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      // The first replay, and one more after the connection the daemon ended: from the last event read, not the start.
      expect(counted.replays).toBe(2);
      expect(counted.replayed).toBeLessThan(total + 256);
      following.close();
    } finally { await s.close(); }
  });

  it("a feed whose hook takes no event for PAUSE_HOLD_MS ends the connection, and goes on from the last event taken on resume", async () => {
    const { hub, counted, listeners } = countingHub(2 * MAX_BEHIND);
    const s = await served("held", hub);
    try {
      const client = await connectDaemon(s.address);
      let open!: () => void;
      const { seqs, handle } = slowHandler(new Promise<void>((resolve) => { open = resolve; }));
      const following = followDaemon(s.address, client!, handle, 0, 200);
      await following.subscribed;
      // The hook hangs: past the hold, the daemon no longer keeps a subscriber for it.
      while (handle.behind() < MAX_BEHIND) await turn();
      await expect.poll(() => listeners.size, { timeout: 5_000 }).toBe(0);
      open();
      const total = 2 * MAX_BEHIND;
      await expect.poll(() => seqs.length, { timeout: 20_000 }).toBe(total);
      expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(counted.replays).toBe(2);
      following.close();
    } finally { await s.close(); }
  });
});
