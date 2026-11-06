import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EventHub, SEQS_RESERVED, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.events

/**
 * A disk with no room left, for the event journal's files only: a write takes what fits, then is refused, and a new file
 * cannot be made. A file rewritten where it is (`r+`) needs no new block: a full APFS, HFS+ or ext4 takes it, a copy on
 * write file system may not (`inPlace: false`).
 */
const disk = vi.hoisted(() => ({ full: false, inPlace: true, fds: new Map<number, string>() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const journal = (path: unknown) => String(path).includes("full-");
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  return {
    ...fs,
    openSync: (path: string, flags = "r", mode?: number) => {
      if (disk.full && journal(path) && /[wax]/.test(flags) && !fs.existsSync(path)) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${path}'`), { code: "ENOSPC", errno: -28, syscall: "open" });
      const fd = fs.openSync(path, flags, mode);
      if (journal(path)) disk.fds.set(fd, flags);
      return fd;
    },
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
      if (disk.fds.get(fd) === "r+") { if (disk.inPlace) return fs.writeSync(fd, bytes, at, length, position); throw enospc(); }
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
      // After a stop and a start too: the mark the full disk refused was written with the next event.
      h.release();
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
    h.release();
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

  it("a stop while the disk is full: the seqs told with no line in the journal are never given again, and a replay across them says events.gap", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = join(dir, "full-stop.jsonl");
    try {
      const { h, heard } = await hub("full-stop.jsonl", "full-stop");
      h.emit("x", "x:1");
      h.emit("x", "x:2");
      // The disk fills: neither the journal nor its `.dropped` mark takes the next events (contacts going offline).
      disk.full = true;
      for (const chat of ["c1", "c2", "c3"]) h.emit("chat.connection", `chat.connection:${chat}:down:1000`, { chat, live: false });
      expect(heard).toEqual([1, 2, 3, 4, 5]);
      expect(lines(path).map((line) => (JSON.parse(line) as GhostlyEvent).seq)).toEqual([1, 2]);
      expect(existsSync(path + ".dropped")).toBe(false);
      // The daemon stops, the disk still full; room is made, and it starts again. A bot's cursor says 5.
      h.release();
      disk.full = false;
      const after = await hub("full-stop.jsonl", "full-stop-again");
      expect(after.h.lastSeq).toBe(5);
      after.h.emit("daemon.started", "daemon.started:1");
      after.h.emit("message.received", "message.received:c1:m1");
      expect(after.heard).toEqual([6, 7]);
      expect(shape(after.h.replay(5))).toEqual([6, 7]);
      expect(shape(after.h.replay(2))).toEqual(["gap 3-5", 6, 7]);
      // And after the next stop and start, the journal having moved on: the gap is still said.
      after.h.release();
      const third = (await hub("full-stop.jsonl", "full-stop-third")).h;
      expect(third.lastSeq).toBe(7);
      expect(shape(third.replay(0))).toEqual([1, 2, "gap 3-5", 6, 7]);
      // As v1.10 reads the folder (a downgrade): the journal holds events only, one per line, and `.dropped` a number.
      const journal = lines(path).map((line) => JSON.parse(line) as GhostlyEvent);
      expect(journal.map((e) => [e.seq, Object.keys(e)])).toEqual([1, 2, 6, 7].map((seq) => [seq, ["seq", "id", "type", "at"]]));
      expect(Number(readFileSync(path + ".dropped", "utf8").trim())).toBe(5);
    } finally { disk.full = false; stderr.mockRestore(); }
  });

  it("a crash on a disk that takes no rewrite either (copy on write): the seqs reserved before it are never given again", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { h, heard } = await hub("full-cow.jsonl", "full-cow");
      h.emit("x", "x:1");
      disk.full = true;
      disk.inPlace = false;
      h.emit("x", "x:2");
      h.emit("x", "x:3");
      expect(heard).toEqual([1, 2, 3]);
      // Killed, nothing given back; the next start with room numbers past every seq the reservation covered.
      disk.full = false;
      disk.inPlace = true;
      const after = (await hub("full-cow.jsonl", "full-cow-again")).h;
      expect(after.lastSeq).toBeGreaterThanOrEqual(3);
      expect(after.lastSeq).toBe(1 + SEQS_RESERVED);
      expect(after.emit("x", "x:4").seq).toBe(2 + SEQS_RESERVED);
      expect(shape(after.replay(1))).toEqual([`gap 2-${1 + SEQS_RESERVED}`, 2 + SEQS_RESERVED]);
      expect(shape(after.replay(3))).toEqual([`gap 4-${1 + SEQS_RESERVED}`, 2 + SEQS_RESERVED]);
    } finally { disk.full = false; disk.inPlace = true; stderr.mockRestore(); }
  });

  it("a `.dropped` mark the full disk refuses as a copy is rewritten where it is", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = join(dir, "full-mark.jsonl");
    try {
      // A mark there already (a trim, or v1.10's): as v1.10 writes it.
      writeFileSync(path, JSON.stringify({ seq: 1, id: "x:1", type: "x", at: 1 }) + "\n");
      writeFileSync(path + ".dropped", "0");
      const { h } = await hub("full-mark.jsonl", "full-mark");
      disk.full = true;
      h.emit("x", "x:2");
      h.emit("x", "x:3");
      expect(Number(readFileSync(path + ".dropped", "utf8").trim())).toBe(3);
      disk.full = false;
      h.emit("x", "x:4");
      expect(shape(h.replay(1))).toEqual(["gap 2-3", 4]);
    } finally { disk.full = false; stderr.mockRestore(); }
  });
});

describe("seq across restarts", () => {
  it("a stop and a start: seq goes on by one, with no gap; a crash: past what was reserved, and a replay across says events.gap", async () => {
    const path = join(dir, "seq-restart.jsonl");
    const { h } = await hub("seq-restart.jsonl", "seq-restart");
    for (let i = 1; i <= 3; i++) h.emit("x", `x:${i}`);
    h.release();
    const again = (await hub("seq-restart.jsonl", "seq-restart-again")).h;
    expect(again.lastSeq).toBe(3);
    expect(again.emit("x", "x:4").seq).toBe(4);
    expect(shape(again.replay(0))).toEqual([1, 2, 3, 4]);
    again.release();
    expect(readFileSync(path + ".reserved", "utf8")).toBe("0000000000000000004\n");
    // Killed after one more event: the next start cannot know which of the reserved seqs were told.
    const third = (await hub("seq-restart.jsonl", "seq-restart-third")).h;
    third.emit("x", "x:5");
    const fourth = (await hub("seq-restart.jsonl", "seq-restart-fourth")).h;
    expect(fourth.lastSeq).toBe(5 + SEQS_RESERVED);
    expect(shape(fourth.replay(5))).toEqual([`gap 6-${5 + SEQS_RESERVED}`]);
    expect(shape(fourth.replay(0))).toEqual([1, 2, 3, 4, 5, `gap 6-${5 + SEQS_RESERVED}`]);
  });

  it("a profile from before the reservation (v1.10, no `.reserved`) starts as it did", async () => {
    const path = join(dir, "seq-old.jsonl");
    writeFileSync(path, [1, 2, 3, 4, 5].map((seq) => JSON.stringify({ seq, id: `x:${seq}`, type: "x", at: 1 }) + "\n").join(""));
    const { h } = await hub("seq-old.jsonl", "seq-old");
    expect(h.lastSeq).toBe(5);
    expect(h.emit("x", "x:6").seq).toBe(6);
    expect(shape(h.replay(0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Number(readFileSync(path + ".reserved", "utf8"))).toBe(6 + SEQS_RESERVED);
  });

  it("a reservation is written once per half of it, before the event that needs it is told", async () => {
    const path = join(dir, "seq-chunks.jsonl");
    const { h } = await hub("seq-chunks.jsonl", "seq-chunks");
    const marks: number[] = [];
    h.onEvent(() => marks.push(Number(readFileSync(path + ".reserved", "utf8"))));
    for (let i = 1; i <= SEQS_RESERVED; i++) h.emit("x", `x:${i}`);
    // Every event told under a mark that covers it; the mark rewritten at the first and at the 130th.
    expect(marks.every((mark, i) => mark >= i + 1)).toBe(true);
    expect([...new Set(marks)]).toEqual([1 + SEQS_RESERVED, 130 + SEQS_RESERVED]);
    expect(marks.indexOf(130 + SEQS_RESERVED)).toBe(129);
  });
});
