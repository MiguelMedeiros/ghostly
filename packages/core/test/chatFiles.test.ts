import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFiles, FILE_LIMITS, refusalText, type ChatFilesHost, type FileTransferRecord, type IncomingTarget, type OfferDecision, type OutgoingSource } from "../src/chatFiles";
import type { FileInfo } from "../src/files";
// covers: files.large.offer, files.large.resume, files.large.integrity, files.large.limits

/** Deterministic bytes for any range: files of any size exist without being held. */
function pattern(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = ((offset + i) * 31 + ((offset + i) >>> 11)) & 0xff;
  return out;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
function patternDigest(size: number): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += 1 << 20) hash.update(pattern(offset, Math.min(1 << 20, size - offset)));
  return hash.digest("base64url");
}

/** A sender's file, generated on read. */
function source(size: number, digest?: string): OutgoingSource & { reads: number } {
  const src = {
    reads: 0,
    async read(offset: number, length: number) { src.reads++; return pattern(offset, Math.max(0, Math.min(length, size - offset))); },
    async digest() { return digest ?? patternDigest(size); },
  };
  return src;
}

/**
 * Storage for a received file: a hash and a count, not the bytes (a 1 GB file never exists here either),
 * plus the length made durable, which is what a restart finds.
 */
class Disk {
  hash = createHash("sha256");
  length = 0;
  durable = 0;
  /** A copy of the bytes, for small files only. */
  bytes: number[] | null;
  failAt = Infinity;
  discarded = false;
  constructor(keep: boolean) { this.bytes = keep ? [] : null; }
  /** What a restart finds: the durable part, hashed again from the pattern. */
  restart(): void {
    this.length = this.durable;
    this.hash = createHash("sha256");
    for (let offset = 0; offset < this.length; offset += 1 << 20) this.hash.update(pattern(offset, Math.min(1 << 20, this.length - offset)));
    if (this.bytes) this.bytes.length = this.length;
  }
  target(): IncomingTarget {
    return {
      offset: this.length,
      append: async (chunk) => {
        if (this.length + chunk.length > this.failAt) throw new Error("disk full");
        this.hash.update(chunk);
        this.length += chunk.length;
        if (this.bytes) for (const b of chunk) this.bytes.push(b);
      },
      flush: async () => { this.durable = this.length; },
      verify: async (digest) => this.hash.copy().digest("base64url") === digest,
      discard: async () => { this.discarded = true; this.length = this.durable = 0; this.hash = createHash("sha256"); if (this.bytes) this.bytes.length = 0; },
    };
  }
}

interface Side {
  files: ChatFiles;
  records: Map<string, FileTransferRecord>;
  transferred: Map<string, number>;
  sent: Record<string, unknown>[];
  decide: (file: FileInfo) => Promise<OfferDecision>;
  disks: Map<string, Disk>;
  sources: Map<string, OutgoingSource>;
}

/**
 * Two chats joined by an ordered, lossy-on-drop wire, each frame through JSON as on a session. Each side
 * handles its frames one at a time, as the paired session does.
 */
function wire(options: { keepBytes?: boolean; drop?: (frame: Record<string, unknown>, from: "a" | "b") => boolean } = {}) {
  let open = true;
  const inbox = { a: [] as string[], b: [] as string[] };
  const busy = { a: false, b: false };
  let outstanding = 0, maxOutstanding = 0;
  const sides = {} as Record<"a" | "b", Side>;
  const deliver = (to: "a" | "b") => {
    if (busy[to]) return;
    busy[to] = true;
    setImmediate(async () => {
      while (inbox[to].length) {
        const frame = JSON.parse(inbox[to].shift()!) as Record<string, unknown>;
        await sides[to].files.handle(frame);
      }
      busy[to] = false;
    });
  };
  const make = (name: "a" | "b", restored: FileTransferRecord[] = []): Side => {
    const other = name === "a" ? "b" : "a";
    const side: Side = {
      records: new Map(), transferred: new Map(), sent: [], disks: sides[name]?.disks ?? new Map(), sources: sides[name]?.sources ?? new Map(),
      decide: async () => "accept",
      files: undefined as unknown as ChatFiles,
    };
    const host: ChatFilesHost = {
      send: (frame) => {
        if (!open) return false;
        // Kept without the bytes: the harness must not hold the file either.
        side.sent.push(frame.t === "pf-data" ? { t: frame.t, id: frame.id, offset: frame.offset } : frame);
        if (frame.t === "pf-data") { outstanding = (frame.offset as number) + FILE_LIMITS.chunkBytes; }
        if (options.drop?.(frame, name)) return true;
        inbox[other].push(JSON.stringify(frame));
        deliver(other);
        return true;
      },
      decide: (file) => side.decide(file),
      openTarget: async (record) => {
        let disk = side.disks.get(record.id);
        if (!disk) { disk = new Disk(!!options.keepBytes); side.disks.set(record.id, disk); }
        return disk.target();
      },
      openSource: async (record) => side.sources.get(record.id)!,
      changed: (record, transferred) => { side.records.set(`${record.direction}:${record.id}`, record); side.transferred.set(`${record.direction}:${record.id}`, transferred); },
      room: async () => 10 * 1024 ** 3,
    };
    side.files = new ChatFiles(host);
    side.files.restore(restored);
    return side;
  };
  sides.a = make("a");
  sides.b = make("b");
  const w = {
    a: sides.a, b: sides.b,
    get maxOutstanding() { return maxOutstanding; },
    attach() { open = true; sides.a.files.attach(); sides.b.files.attach(); },
    /** The session drops: both sides see it, and what was on the wire is lost. */
    drop() { open = false; inbox.a.length = inbox.b.length = 0; sides.a.files.detach(); sides.b.files.detach(); },
    /** One side's app restarts: a new ChatFiles from the records it kept. */
    restart(name: "a" | "b") {
      const kept = [...sides[name].records.values()];
      for (const disk of sides[name].disks.values()) disk.restart();
      sides[name] = make(name, kept);
      w[name] = sides[name];
    },
    trackWindow() {
      // Outstanding bytes seen by the sender: data sent minus data confirmed.
      const confirmed = () => Math.max(0, ...[...sides.a.records.values()].map((r) => r.confirmed));
      const timer = setInterval(() => { maxOutstanding = Math.max(maxOutstanding, outstanding - confirmed()); }, 0);
      return () => clearInterval(timer);
    },
  };
  return w;
}

const file = (id: string, size: number, over: Partial<FileInfo> = {}): FileInfo => ({ id, name: `${id}.bin`, mime: "application/octet-stream", size, timestamp: 1_700_000_000_000, ...over });
const state = (side: Side, direction: "in" | "out", id: string) => side.records.get(`${direction}:${id}`)?.state;
async function until(check: () => unknown, timeout = 20_000): Promise<void> {
  await vi.waitFor(() => { if (!check()) throw new Error("not yet"); }, { timeout, interval: 5 });
}

function send(w: ReturnType<typeof wire>, info: FileInfo, digest?: string) {
  w.a.sources.set(info.id, source(info.size, digest));
  return w.a.files.offer(info);
}

afterEach(() => vi.useRealTimers());

describe("files/3 between two chats", { timeout: 30_000 }, () => {
  it("a small file is taken without asking, sent in windows, checked and kept", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    send(w, file("small-001", 100_000));
    await until(() => state(w.a, "out", "small-001") === "done");
    expect(state(w.b, "in", "small-001")).toBe("done");
    expect(Uint8Array.from(w.b.disks.get("small-001")!.bytes!)).toEqual(pattern(0, 100_000));
    expect(w.b.records.get("in:small-001")).toMatchObject({ confirmed: 100_000, digest: patternDigest(100_000) });
    expect(w.a.transferred.get("out:small-001")).toBe(100_000);
    // Many chunks went before the first confirmation: this is not stop-and-wait.
    const firstGot = w.b.sent.findIndex((f) => f.t === "pf-got");
    const dataBeforeGot = w.a.sent.filter((f, i) => f.t === "pf-data" && i < w.a.sent.length).length;
    expect(firstGot).toBeGreaterThan(-1);
    expect(dataBeforeGot).toBe(Math.ceil(100_000 / FILE_LIMITS.chunkBytes));
  });

  it("an empty file goes too", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    send(w, file("empty-01", 0));
    await until(() => state(w.a, "out", "empty-01") === "done");
    expect(state(w.b, "in", "empty-01")).toBe("done");
  });

  it("a file offered while no session is open waits, then goes on the next one", async () => {
    const w = wire();
    send(w, file("later-01", 50_000));
    expect(state(w.a, "out", "later-01")).toBe("queued");
    w.attach();
    await until(() => state(w.a, "out", "later-01") === "done");
  });

  it("a large file waits for the person: accepted, it goes; the sender says what it waits for", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    send(w, file("large-01", 300_000));
    await until(() => state(w.b, "in", "large-01") === "asking");
    await until(() => state(w.a, "out", "large-01") === "asking");
    expect(w.a.records.get("out:large-01")?.waitingFor).toBe("consent");
    // Offered again (a new session): still asking, nothing sent.
    w.drop(); w.attach();
    await until(() => state(w.a, "out", "large-01") === "asking");
    expect(w.a.sent.some((f) => f.t === "pf-data")).toBe(false);
    w.b.files.accept("large-01");
    expect(w.b.records.get("in:large-01")?.consented).toBe(true);
    await until(() => state(w.a, "out", "large-01") === "done");
    expect(state(w.b, "in", "large-01")).toBe("done");
  });

  it("the person can accept while the sender is away; it goes when they are back", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    send(w, file("away-001", 70_000));
    await until(() => state(w.b, "in", "away-001") === "asking");
    w.drop();
    w.b.files.accept("away-001");
    expect(state(w.b, "in", "away-001")).toBe("queued");
    w.attach();
    await until(() => state(w.a, "out", "away-001") === "done");
  });

  it("a declined file stays declined, on both sides, whatever the sender offers again", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    send(w, file("nope-001", 30_000));
    await until(() => state(w.b, "in", "nope-001") === "asking");
    w.b.files.decline("nope-001");
    await until(() => state(w.a, "out", "nope-001") === "declined");
    expect(w.a.records.get("out:nope-001")?.error).toBe("Declined by your contact");
    w.drop(); w.attach();
    await new Promise((r) => setTimeout(r, 20));
    expect(state(w.b, "in", "nope-001")).toBe("declined");
  });

  it("a refusal says why: no room (with the room), too many offers", async () => {
    const w = wire();
    w.b.decide = async () => ({ refuse: "no-room", room: 5 * 1024 ** 3 });
    w.attach();
    send(w, file("room-001", 6 * 1024 ** 3));
    await until(() => state(w.a, "out", "room-001") === "failed");
    expect(w.a.records.get("out:room-001")?.error).toBe("Not enough space on your contact's device (5.0 GB free)");
    expect(w.b.records.has("in:room-001")).toBe(false);
    expect(refusalText("too-many").error).toContain("too many files");
  });

  it("either side pauses and resumes; the transfer goes on from where it stood", async () => {
    const w = wire();
    w.attach();
    const size = 3 * 1024 * 1024;
    send(w, file("pause-01", size));
    await until(() => (w.b.transferred.get("in:pause-01") ?? 0) > 200_000);
    w.b.files.pause("in", "pause-01");
    await until(() => state(w.a, "out", "pause-01") === "paused");
    expect(w.a.records.get("out:pause-01")?.pausedBy).toBe("peer");
    const heldAt = w.b.transferred.get("in:pause-01")!;
    await new Promise((r) => setTimeout(r, 30));
    expect(state(w.b, "in", "pause-01")).toBe("paused");
    w.b.files.resume("in", "pause-01");
    await until(() => (w.b.transferred.get("in:pause-01") ?? 0) > heldAt + 200_000);
    w.a.files.pause("out", "pause-01");
    await until(() => state(w.b, "in", "pause-01") === "paused" && w.b.records.get("in:pause-01")?.pausedBy === "peer");
    w.a.files.resume("out", "pause-01");
    await until(() => state(w.a, "out", "pause-01") === "done");
    expect(state(w.b, "in", "pause-01")).toBe("done");
  });

  it("the sender cancels: the receiver drops what it had; the receiver cancels: the sender stops", async () => {
    const w = wire();
    w.attach();
    send(w, file("cancel-1", 4 * 1024 * 1024));
    await until(() => (w.b.transferred.get("in:cancel-1") ?? 0) > 100_000);
    w.a.files.cancel("out", "cancel-1");
    await until(() => state(w.b, "in", "cancel-1") === "cancelled");
    expect(w.b.records.get("in:cancel-1")?.error).toBe("Cancelled by the sender");
    expect(w.b.disks.get("cancel-1")!.discarded).toBe(true);

    send(w, file("cancel-2", 4 * 1024 * 1024));
    await until(() => (w.b.transferred.get("in:cancel-2") ?? 0) > 100_000);
    w.b.files.cancel("in", "cancel-2");
    await until(() => state(w.a, "out", "cancel-2") === "cancelled");
    expect(w.a.records.get("out:cancel-2")?.error).toBe("Cancelled by your contact");
  });

  it("a drop mid-way resumes from the receiver's last byte, and nothing is sent twice that arrived", async () => {
    const w = wire();
    w.attach();
    const size = 5 * 1024 * 1024 + 123;
    send(w, file("drop-001", size));
    await until(() => (w.b.transferred.get("in:drop-001") ?? 0) > 2 * 1024 * 1024);
    w.drop();
    const had = w.b.disks.get("drop-001")!.length;
    w.attach();
    await until(() => state(w.a, "out", "drop-001") === "done");
    expect(state(w.b, "in", "drop-001")).toBe("done");
    const accept = w.b.sent.filter((f) => f.t === "pf-accept" && f.id === "drop-001").at(-1)!;
    expect(accept.offset).toBe(had);
    const resent = w.a.sent.filter((f) => f.t === "pf-data" && (f.offset as number) < had).length;
    // Before the drop, the first window; after it, nothing below what had arrived.
    expect(resent).toBeLessThanOrEqual(Math.ceil(had / FILE_LIMITS.chunkBytes));
  });

  it("the receiver restarts mid-way: it resumes from its last durable point, not from zero", async () => {
    const w = wire();
    w.attach();
    const size = 20 * 1024 * 1024;
    send(w, file("restart1", size));
    await until(() => (w.b.records.get("in:restart1")?.confirmed ?? 0) >= FILE_LIMITS.checkpointBytes);
    w.drop();
    w.restart("b");
    const durable = w.b.disks.get("restart1")!.durable;
    expect(durable).toBeGreaterThanOrEqual(FILE_LIMITS.checkpointBytes);
    w.attach();
    await until(() => state(w.a, "out", "restart1") === "done", 30_000);
    expect(state(w.b, "in", "restart1")).toBe("done");
    const accepts = w.b.sent.filter((f) => f.t === "pf-accept");
    expect(accepts[0].offset).toBe(durable);
  });

  it("the sender restarts mid-way: it offers again from its records and the receiver says where to go on", async () => {
    const w = wire();
    w.attach();
    const size = 6 * 1024 * 1024;
    send(w, file("restart2", size));
    await until(() => (w.a.records.get("out:restart2")?.confirmed ?? 0) > 1024 * 1024);
    w.drop();
    w.restart("a");
    w.attach();
    await until(() => state(w.a, "out", "restart2") === "done");
    expect(state(w.b, "in", "restart2")).toBe("done");
  });

  it("a lost chunk (a transport switch) makes the receiver say where it stands, and the sender goes back", async () => {
    let lost = false;
    const w = wire({ keepBytes: true, drop: (frame) => {
      if (!lost && frame.t === "pf-data" && frame.offset === 5 * FILE_LIMITS.chunkBytes) { lost = true; return true; }
      return false;
    } });
    w.attach();
    const size = 40 * FILE_LIMITS.chunkBytes;
    send(w, file("gap-0001", size));
    await until(() => state(w.a, "out", "gap-0001") === "done");
    expect(Uint8Array.from(w.b.disks.get("gap-0001")!.bytes!)).toEqual(pattern(0, size));
    expect(w.b.sent.filter((f) => f.t === "pf-accept").map((f) => f.offset)).toEqual([0, 5 * FILE_LIMITS.chunkBytes]);
  });

  it("the last frames lost with nothing after them: the sender offers again after a quiet spell", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let lose = true;
    const w = wire({ drop: (frame) => lose && frame.t === "pf-sum" });
    w.attach();
    send(w, file("quiet-01", 50_000));
    await until(() => w.a.sent.some((f) => f.t === "pf-sum"));
    lose = false;
    expect(state(w.a, "out", "quiet-01")).toBe("verifying");
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.idleMs);
    await until(() => state(w.a, "out", "quiet-01") === "done");
  });

  it("a digest that does not match deletes the file on arrival and says so on both sides", async () => {
    const w = wire();
    w.attach();
    send(w, file("bad-0001", 70_000), patternDigest(69_999));
    await until(() => state(w.a, "out", "bad-0001") === "failed");
    expect(w.a.records.get("out:bad-0001")?.error).toContain("arrived damaged");
    expect(state(w.b, "in", "bad-0001")).toBe("failed");
    expect(w.b.records.get("in:bad-0001")?.error).toContain("damaged and was deleted");
    expect(w.b.disks.get("bad-0001")!.discarded).toBe(true);
    // Sent again with the right digest, it is taken from the start.
    w.a.sources.set("bad-0001", source(70_000));
    w.a.files.retry("bad-0001");
    await until(() => state(w.a, "out", "bad-0001") === "done");
    expect(state(w.b, "in", "bad-0001")).toBe("done");
  });

  it("storage failing mid-way ends the transfer on both sides instead of hanging", async () => {
    const w = wire();
    w.attach();
    send(w, file("full-001", 2 * 1024 * 1024));
    await until(() => w.b.disks.has("full-001"));
    w.b.disks.get("full-001")!.failAt = 500_000;
    await until(() => state(w.a, "out", "full-001") === "failed");
    expect(w.b.records.get("in:full-001")?.error).toContain("disk full");
  });

  it("at most three files arrive at once from one contact; the others wait their turn", async () => {
    const w = wire();
    w.attach();
    for (let i = 0; i < 5; i++) send(w, file(`many-00${i}`, 2 * 1024 * 1024));
    await until(() => [...w.b.records.values()].filter((r) => r.state === "queued").length === 2);
    expect([...w.b.records.values()].filter((r) => r.state === "active").length).toBe(3);
    expect([...w.a.records.values()].filter((r) => r.waitingFor === "busy").length).toBe(2);
    await until(() => [...w.a.records.values()].every((r) => r.state === "done"), 30_000);
  });

  it("no more than 16 offers wait for an answer; the 17th is refused", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    for (let i = 0; i < 17; i++) send(w, file(`ask-${String(i).padStart(4, "0")}`, 10));
    await until(() => state(w.a, "out", "ask-0016") === "failed");
    expect(w.a.records.get("out:ask-0016")?.error).toContain("too many files");
    expect([...w.b.records.values()].filter((r) => r.state === "asking")).toHaveLength(16);
  });

  it("an offer nobody answers ends after a week, on both sides", async () => {
    let now = 1_000;
    const w = wire();
    w.b.decide = async () => "ask";
    for (const side of [w.a, w.b]) (side.files as unknown as { host: ChatFilesHost }).host.now = () => now;
    w.attach();
    send(w, file("week-001", 40 * 1024 * 1024));
    await until(() => state(w.a, "out", "week-001") === "asking");
    now += FILE_LIMITS.offerTtlMs + 1;
    w.b.files.sweep();
    w.a.files.sweep();
    await until(() => state(w.a, "out", "week-001") === "failed");
    expect(w.b.records.get("in:week-001")?.error).toBe("The offer expired");
  });

  it("malformed offers are refused, and data for nothing, or out of bounds, is ignored", async () => {
    const w = wire();
    w.attach();
    const b = w.b.files;
    await b.handle({ t: "pf-offer", id: "bad-name1", name: 5, mime: "x/y", size: 1, ts: 1 });
    await b.handle({ t: "pf-offer", id: "bad-size1", name: "a", mime: "x/y", size: -1, ts: 1 });
    await b.handle({ t: "pf-offer", id: "bad-size2", name: "a", mime: "x/y", size: 2 ** 60, ts: 1 });
    await b.handle({ t: "pf-offer", id: "x", name: "a", mime: "x/y", size: 1, ts: 1 });
    expect(w.b.sent.filter((f) => f.t === "pf-refuse").map((f) => f.why)).toEqual(["invalid", "invalid", "invalid"]);
    await b.handle({ t: "pf-data", id: "nothing1", offset: 0, data: b64(pattern(0, 10)) });
    await b.handle({ t: "pf-offer", id: "okay-001", name: "a", mime: "x/y", size: 10, ts: 1 });
    await until(() => state(w.b, "in", "okay-001") === "active");
    w.drop(); // nothing reaches the sender (there is none): the tests feed frames by hand
    w.b.files.attach();
    await b.handle({ t: "pf-data", id: "okay-001", offset: 0, data: b64(pattern(0, 11)) });
    await b.handle({ t: "pf-data", id: "okay-001", offset: 0, data: "!!!" });
    expect(w.b.disks.get("okay-001")!.length).toBe(0);
    // A different file under the same id is not the same offer.
    await b.handle({ t: "pf-offer", id: "okay-001", name: "b", mime: "x/y", size: 10, ts: 1 });
  });

  it("each side tells the other how much it can take", async () => {
    const w = wire();
    w.attach();
    await until(() => w.a.files.peerRoom === 10 * 1024 ** 3);
    w.drop();
    expect(w.a.files.peerRoom).toBeNull();
  });
});

/** 256 MiB in CI; `GHOSTLY_BIG_FILE_MB=1024` for the full gigabyte (about 45 s here). */
describe("a large file, generated as it is read", () => {
  const SIZE = Number(process.env.GHOSTLY_BIG_FILE_MB ?? 256) * 1024 * 1024;

  it("goes whole through a drop and a resume, in bounded memory, and checks out", async () => {
    const w = wire();
    const stop = w.trackWindow();
    w.attach();
    const digest = patternDigest(SIZE);
    send(w, file("gigabyte", SIZE), digest);
    const base = process.memoryUsage();
    let peak = 0;
    const sample = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 20);
    try {
      await until(() => (w.b.transferred.get("in:gigabyte") ?? 0) > SIZE / 2, 240_000);
      w.drop();
      const had = w.b.disks.get("gigabyte")!.length;
      w.attach();
      await until(() => state(w.a, "out", "gigabyte") === "done", 240_000);
      expect(state(w.b, "in", "gigabyte")).toBe("done");
      expect(w.b.disks.get("gigabyte")!.length).toBe(SIZE);
      expect(w.b.sent.filter((f) => f.t === "pf-accept").map((f) => f.offset)).toEqual([0, had]);
    } finally { clearInterval(sample); stop(); }
    // The sender never had more than a window out, and nothing grew with the file.
    expect(w.maxOutstanding).toBeLessThanOrEqual(FILE_LIMITS.windowBytes + FILE_LIMITS.chunkBytes);
    // Well under the file: it was never held, by either side or the wire.
    expect(peak, `peak ${Math.round(peak / 2 ** 20)} MiB over the start`).toBeLessThan(96 * 1024 * 1024);
    appendFileSync(process.env.GHOSTLY_FILE_PEAK_LOG ?? "/dev/null", `${SIZE} bytes, peak ${Math.round(peak / 2 ** 20)} MiB\n`);
  }, 300_000);
});
