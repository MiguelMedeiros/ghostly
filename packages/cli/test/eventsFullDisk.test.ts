import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events

/** A disk with no room left, for the event journal's files only: a write takes what fits, then is refused. */
const disk = vi.hoisted(() => ({ full: false, fds: new Set<number>() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const journal = (path: unknown) => String(path).includes("full-");
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  return {
    ...fs,
    openSync: (path: string, flags = "r", mode?: number) => { const fd = fs.openSync(path, flags, mode); if (journal(path)) disk.fds.add(fd); return fd; },
    closeSync: (fd: number) => { disk.fds.delete(fd); fs.closeSync(fd); },
    appendFileSync: (path: string, data: string | Buffer, options?: never) => {
      if (!disk.full || !journal(path)) return fs.appendFileSync(path, data, options);
      fs.appendFileSync(path, String(data).slice(0, String(data).length >> 1), options);
      throw enospc();
    },
    writeFileSync: (path: string, data: string | Buffer, options?: never) => {
      if (disk.full && journal(path)) throw enospc();
      return fs.writeFileSync(path, data, options);
    },
    writeSync: (fd: number, bytes: Buffer, at = 0, length?: number, position?: number | null) => {
      if (!disk.full || !disk.fds.has(fd)) return fs.writeSync(fd, bytes, at, length, position);
      if (bytes.length - at >= 2) return fs.writeSync(fd, bytes, at, (bytes.length - at) >> 1);
      throw enospc();
    },
  };
});

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-events-full-"));
  await openPersistentIndexedDb(join(dir, "db"));
});

async function hub(journal: string, seenDb: string) {
  const h = new EventHub(join(dir, journal), () => 1000, seenDb);
  await h.open();
  const heard: number[] = [];
  h.onEvent((e) => heard.push(e.seq));
  return { h, heard };
}

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);
const shape = (events: GhostlyEvent[]) => events.map((e) => (e.type === "events.gap" ? `gap ${e.from}-${e.to}` : e.seq));

describe("the event journal on a full disk", () => {
  it("cuts back what a full disk took of an event: the first one written once there is room is replayed, and the lost ones are a gap", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = join(dir, "full-run.jsonl");
    try {
      const { h, heard } = await hub("full-run.jsonl", "full-run");
      h.emit("x", "x:1");
      disk.full = true;
      h.emit("x", "x:2", { text: "F".repeat(900) });
      h.emit("x", "x:3", { text: "F".repeat(900) });
      disk.full = false;
      // The listeners heard them all; the journal has no part of the two it could not take.
      expect(heard).toEqual([1, 2, 3]);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
      // Nothing came after them yet: a cursor before them hears they are gone.
      expect(shape(h.replay(1))).toEqual(["gap 2-3"]);
      h.emit("x", "x:4");
      expect(lines(path).map((line) => (JSON.parse(line) as GhostlyEvent).seq)).toEqual([1, 4]);
      const check = (hub: EventHub) => {
        expect(hub.lastSeq).toBe(4);
        expect(shape(hub.replay(0))).toEqual([1, "gap 2-3", 4]);
        expect(shape(hub.replay(1))).toEqual(["gap 2-3", 4]);
        expect(shape(hub.replay(2))).toEqual(["gap 3-3", 4]);
        expect(shape(hub.replay(3))).toEqual([4]);
      };
      check(h);
      // After a restart too: the mark the full disk refused was written with the next event.
      check((await hub("full-run.jsonl", "full-run-again")).h);
    } finally { disk.full = false; stderr.mockRestore(); }
  });

  it("a journal whose last line a crash cut is cut back at the next start: its seq is not given again, and is a gap", async () => {
    const path = join(dir, "cut-start.jsonl");
    writeFileSync(path, [1, 2, 3].map((seq) => JSON.stringify({ seq, id: `x:${seq}`, type: "x", at: 1 }) + "\n").join("") + '{"seq":4,"id":"message.received:c1:torn","type":"message.rece');
    const { h } = await hub("cut-start.jsonl", "cut-start");
    expect(h.lastSeq).toBe(4);
    h.emit("daemon.started", "daemon.started:1");
    expect(lines(path).map((line) => (JSON.parse(line) as GhostlyEvent).seq)).toEqual([1, 2, 3, 5]);
    expect(shape(h.replay(3))).toEqual(["gap 4-4", 5]);
    const again = (await hub("cut-start.jsonl", "cut-start-again")).h;
    expect(again.lastSeq).toBe(5);
    expect(shape(again.replay(3))).toEqual(["gap 4-4", 5]);
  });

  it("a whole last event with no newline is kept and ended, and the next one is a line of its own", async () => {
    const path = join(dir, "unended-start.jsonl");
    writeFileSync(path, [1, 2].map((seq) => JSON.stringify({ seq, id: `x:${seq}`, type: "x", at: 1 })).join("\n"));
    const { h } = await hub("unended-start.jsonl", "unended-start");
    expect(h.lastSeq).toBe(2);
    h.emit("daemon.started", "daemon.started:1");
    expect(shape(h.replay(0))).toEqual([1, 2, 3]);
    expect(lines(path)).toHaveLength(3);
  });
});
