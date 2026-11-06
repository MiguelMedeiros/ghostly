import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFiles, FILE_LIMITS, refusalText, sentWhole, transferStalled, type ChatFilesHost, type FileTransferRecord, type IncomingTarget, type OfferDecision, type OutgoingSource } from "../src/chatFiles";
import type { FileInfo } from "../src/files";
// covers: files.video.meta, files.image.meta, files.large.offer, files.large.resume, files.large.integrity, files.large.limits, files.large.resend, files.large.request, apps.offer.wire

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
  /** What a write past `failAt` throws: "disk full" when unset. */
  failWith?: unknown;
  discarded = false;
  /** The check of the digest waits for this, as one over a large file takes a while. */
  checking?: Promise<void>;
  /** Every target opened on it, without keeping one alive. */
  opened: WeakRef<IncomingTarget>[] = [];
  /** Each write takes this long (ms), as storage slower than the wire does: what arrives queues up behind it. */
  constructor(keep: boolean, private writeMs = 0) { this.bytes = keep ? [] : null; }
  /** What a restart finds: the durable part, hashed again from the pattern. */
  restart(): void {
    this.length = this.durable;
    this.hash = createHash("sha256");
    for (let offset = 0; offset < this.length; offset += 1 << 20) this.hash.update(pattern(offset, Math.min(1 << 20, this.length - offset)));
    if (this.bytes) this.bytes.length = this.length;
  }
  target(): IncomingTarget {
    const target: IncomingTarget = {
      offset: this.length,
      append: async (chunk) => {
        if (this.writeMs) await new Promise((resolve) => setTimeout(resolve, this.writeMs));
        if (this.length + chunk.length > this.failAt) throw this.failWith ?? new Error("disk full");
        this.hash.update(chunk);
        this.length += chunk.length;
        if (this.bytes) for (const b of chunk) this.bytes.push(b);
      },
      flush: async () => { this.durable = this.length; },
      verify: async (digest) => { await this.checking; return this.hash.copy().digest("base64url") === digest; },
      discard: async () => { this.discarded = true; this.length = this.durable = 0; this.hash = createHash("sha256"); if (this.bytes) this.bytes.length = 0; },
    };
    this.opened.push(new WeakRef(target));
    return target;
  }
}

interface Side {
  files: ChatFiles;
  records: Map<string, FileTransferRecord>;
  transferred: Map<string, number>;
  sent: Record<string, unknown>[];
  decide: (file: FileInfo, again?: boolean) => Promise<OfferDecision>;
  disks: Map<string, Disk>;
  sources: Map<string, OutgoingSource>;
  /** Changes of a record other than progress: each one the app stores at once. */
  stateChanges: number;
}

/**
 * Two chats joined by an ordered, lossy-on-drop wire, each frame through JSON as on a session. Each side
 * handles its frames one at a time, as the paired session does.
 */
function wire(options: {
  keepBytes?: boolean;
  drop?: (frame: Record<string, unknown>, from: "a" | "b") => boolean;
  /**
   * A channel like the native and iroh ones: frames past this many queued bytes are refused, and what is queued only
   * drains on a later turn of the event loop (a timer), never while promises keep running.
   */
  budget?: number;
  /** With `budget`: the host says when the channel has room, as GhostLink's `filesWritable` does. */
  writable?: boolean;
  /** Storage that takes this long (ms) for each write. */
  writeMs?: number;
  /** Storage that takes this long (ms) to open a received file, as a database lookup does. */
  openMs?: number;
} = {}) {
  let open = true;
  const queued = { a: 0, b: 0 };
  const drains = { a: [] as (() => void)[], b: [] as (() => void)[] };
  const refusals = { a: 0, b: 0 };
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
      stateChanges: 0,
    };
    const host: ChatFilesHost = {
      send: (frame) => {
        if (!open) return false;
        if (options.budget) {
          const bytes = JSON.stringify(frame).length;
          if (queued[name] + bytes > options.budget) {
            // A sender that tries again at once never lets the timer below run: stop it here instead of hanging.
            if (++refusals[name] > 5_000) throw new Error("the sender keeps sending into a full channel");
            return false;
          }
          queued[name] += bytes;
          setTimeout(() => {
            queued[name] -= bytes;
            if (!queued[name]) for (const drained of drains[name].splice(0)) drained();
          }, 1);
        }
        // Kept without the bytes: the harness must not hold the file either.
        side.sent.push(frame.t === "pf-data" ? { t: frame.t, id: frame.id, offset: frame.offset } : frame);
        if (frame.t === "pf-data") { outstanding = (frame.offset as number) + FILE_LIMITS.chunkBytes; }
        if (options.drop?.(frame, name)) return true;
        inbox[other].push(JSON.stringify(frame));
        deliver(other);
        return true;
      },
      decide: (file, again) => side.decide(file, again),
      openTarget: async (record) => {
        if (options.openMs) await new Promise((resolve) => setTimeout(resolve, options.openMs));
        let disk = side.disks.get(record.id);
        if (!disk) { disk = new Disk(!!options.keepBytes, options.writeMs); side.disks.set(record.id, disk); }
        return disk.target();
      },
      openSource: async (record) => side.sources.get(record.id)!,
      changed: (record, transferred, progress) => { if (!progress) side.stateChanges++; side.records.set(`${record.direction}:${record.id}`, record); side.transferred.set(`${record.direction}:${record.id}`, transferred); },
      room: async () => 10 * 1024 ** 3,
      ...(options.budget && options.writable && {
        writable: () => queued[name] < options.budget! / 4 ? undefined
          : (async () => { while (queued[name] >= options.budget! / 4) await new Promise<void>((resolve) => drains[name].push(resolve)); })(),
      }),
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
    refusals,
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

  it("a transfer that ended lets go of where it was written: done, damaged or declined", async () => {
    const w = wire();
    w.attach();
    send(w, file("kept-0001", 100_000));
    // The digest of another size: every byte arrives, and the check fails.
    send(w, file("damaged-1", 100_000), patternDigest(1000));
    await until(() => state(w.b, "in", "kept-0001") === "done" && state(w.b, "in", "damaged-1") === "failed");
    w.b.decide = async () => "ask";
    send(w, file("nope-0001", 30_000));
    await until(() => state(w.b, "in", "nope-0001") === "asking");
    w.b.files.decline("nope-0001");
    await until(() => state(w.a, "out", "nope-0001") === "declined");
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    // A host's target holds what writes it (a 256 KiB gather buffer in the apps): kept, every file received kept one.
    const held = [...w.b.disks].filter(([, disk]) => disk.opened.some((ref) => ref.deref())).map(([id]) => id);
    expect(w.b.disks.size).toBe(3);
    expect(held).toEqual([]);
  });

  it("an offer carries the message the file answers (r), kept with the record", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    const reply = { i: "AbCdEfGhIjKlMnOpQrStUv", s: "listen to this", f: "sender" };
    send(w, { ...file("reply-01", 1000), reply });
    await until(() => state(w.b, "in", "reply-01") === "done");
    expect(w.a.sent.find((f) => f.t === "pf-offer")).toMatchObject({ r: reply });
    expect(w.b.records.get("in:reply-01")!.file.reply).toEqual(reply);
  });

  it("an offer carries the mini-app that sent it ahead (app), kept with the record; a malformed one is dropped, the file still arrives", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    const app = "AbCdEfGhIjKlMnOpQrStUv";
    send(w, { ...file("ahead-01", 1000), app });
    send(w, { ...file("ahead-02", 1000), app: "short" });
    await until(() => state(w.b, "in", "ahead-01") === "done" && state(w.b, "in", "ahead-02") === "done");
    expect(w.a.sent.find((f) => f.t === "pf-offer" && f.id === "ahead-01")).toMatchObject({ app });
    expect(w.a.sent.find((f) => f.t === "pf-offer" && f.id === "ahead-02")).not.toHaveProperty("app");
    expect(w.b.records.get("in:ahead-01")!.file.app).toBe(app);
    // Read as it arrives: a key that is not a chat app id is dropped, and the file is taken as any file.
    await w.b.files.handle({ t: "pf-offer", id: "ahead-03", name: "a", mime: "x/y", size: 10, ts: 1, app: "AbCdEfGhIjKlMnOpQrStU!" });
    await until(() => state(w.b, "in", "ahead-03") !== undefined);
    expect(w.b.records.get("in:ahead-03")!.file).not.toHaveProperty("app");
  });

  it("an empty file goes too", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    send(w, file("empty-01", 0));
    await until(() => state(w.a, "out", "empty-01") === "done");
    expect(state(w.b, "in", "empty-01")).toBe("done");
  });

  it("a video's description goes with its offer; a bad poster is dropped, the file still arrives", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    const poster = b64(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 180, 1, 64, 3, 1, 2, 3])); // a JPEG frame header: 320 × 180
    send(w, file("video-01", 40_000, { mime: "video/mp4", video: { duration: 3000, width: 320, height: 180, poster } }));
    send(w, file("video-02", 40_000, { mime: "video/mp4", video: { duration: 3000, width: 320, height: 180, poster: "not a jpeg" } }));
    await until(() => state(w.b, "in", "video-01") === "done" && state(w.b, "in", "video-02") === "done");
    expect(w.b.records.get("in:video-01")!.file.video).toEqual({ duration: 3000, width: 320, height: 180, poster });
    expect(w.b.records.get("in:video-02")!.file.video).toEqual({ duration: 3000, width: 320, height: 180 });
  });

  it("a picture's size goes with its offer; an offer without one, or with a bad one, still brings the file", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    send(w, file("image-01", 40_000, { mime: "image/jpeg", image: { width: 4032, height: 3024 } }));
    send(w, file("image-02", 40_000, { mime: "image/png" }));
    send(w, file("image-03", 40_000, { mime: "image/webp", image: { width: 0, height: 10 } }));
    // Not a picture: the size is not taken.
    send(w, file("image-04", 40_000, { image: { width: 10, height: 10 } }));
    await until(() => ["image-01", "image-02", "image-03", "image-04"].every((id) => state(w.b, "in", id) === "done"));
    expect(w.b.records.get("in:image-01")!.file.image).toEqual({ width: 4032, height: 3024 });
    for (const id of ["image-02", "image-03", "image-04"]) expect(w.b.records.get(`in:${id}`)!.file.image).toBeUndefined();
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

  it("the sender pauses before the person there answers: it stays paused when they accept, and goes on resume", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    send(w, file("pask-001", 300_000));
    await until(() => state(w.a, "out", "pask-001") === "asking");
    w.a.files.pause("out", "pask-001");
    // The paused offer is answered "still asking": that answer must not undo the pause.
    await until(() => w.a.sent.filter((f) => f.t === "pf-offer").length >= 2 && w.b.sent.filter((f) => f.t === "pf-wait").length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.a.records.get("out:pask-001")).toMatchObject({ state: "paused", pausedBy: "me" });
    w.b.files.accept("pask-001");
    await until(() => state(w.b, "in", "pask-001") === "paused");
    expect(w.b.records.get("in:pask-001")?.pausedBy).toBe("peer");
    expect(w.a.records.get("out:pask-001")).toMatchObject({ state: "paused", pausedBy: "me" });
    expect(w.a.sent.some((f) => f.t === "pf-data")).toBe(false);
    w.a.files.resume("out", "pask-001");
    await until(() => state(w.a, "out", "pask-001") === "done");
    expect(state(w.b, "in", "pask-001")).toBe("done");
  });

  it("after the receiver's restart, its cancel or the sender's drops what it had, though nothing arrived since", async () => {
    const w = wire();
    w.attach();
    send(w, file("restart-c", 4 * 1024 * 1024));
    await until(() => (w.b.transferred.get("in:restart-c") ?? 0) > 100_000);
    w.drop();
    w.restart("b");
    w.b.files.cancel("in", "restart-c");
    expect(state(w.b, "in", "restart-c")).toBe("cancelled");
    await until(() => w.b.disks.get("restart-c")!.discarded);

    w.attach();
    send(w, file("restart-a", 4 * 1024 * 1024));
    await until(() => (w.b.transferred.get("in:restart-a") ?? 0) > 100_000);
    w.drop();
    w.restart("b");
    // The sender cancels while the receiver's app is closed; back, the receiver asks again and is told.
    w.a.files.cancel("out", "restart-a");
    w.attach();
    expect(w.b.files.request("restart-a")).toBe(true);
    await until(() => state(w.b, "in", "restart-a") === "cancelled");
    await until(() => w.b.disks.get("restart-a")!.discarded);
  });

  it("a file the sender deleted while the receiver was away: asked about it, the sender says it ended, before or after its restart", async () => {
    const w = wire();
    w.attach();
    send(w, file("forgot-01", 4 * 1024 * 1024));
    send(w, file("forgot-02", 4 * 1024 * 1024));
    await until(() => ["forgot-01", "forgot-02"].every((id) => (w.b.transferred.get(`in:${id}`) ?? 0) > 100_000));
    w.drop();
    // Its message deleted: the abort finds no session, and the record goes with the message.
    w.a.files.forget("out", "forgot-01");
    w.a.files.forget("out", "forgot-02");
    w.a.records.delete("out:forgot-01");
    w.a.records.delete("out:forgot-02");
    w.attach();
    expect(w.b.files.request("forgot-01")).toBe(true);
    await until(() => state(w.b, "in", "forgot-01") === "cancelled");
    expect(w.b.records.get("in:forgot-01")?.error).toBe("Cancelled by the sender");
    await until(() => w.b.disks.get("forgot-01")!.discarded);
    w.drop();
    w.restart("a");
    w.attach();
    expect(w.b.files.request("forgot-02")).toBe(true);
    await until(() => state(w.b, "in", "forgot-02") === "cancelled");
    await until(() => w.b.disks.get("forgot-02")!.discarded);
  });

  it("an offer that expired on the sender's side first: accepted then, the receiver hears it ended", async () => {
    let now = 1_000;
    const w = wire();
    w.b.decide = async () => "ask";
    for (const side of [w.a, w.b]) (side.files as unknown as { host: ChatFilesHost }).host.now = () => now;
    // Offered while the receiver was away: its week begins when the offer arrives, a day after the sender's.
    w.drop();
    send(w, file("week-003", 40 * 1024 * 1024));
    now += 24 * 60 * 60 * 1000;
    w.attach();
    await until(() => state(w.b, "in", "week-003") === "asking");
    w.drop();
    now += FILE_LIMITS.offerTtlMs - 24 * 60 * 60 * 1000 + 1;
    w.a.files.sweep();
    expect(state(w.a, "out", "week-003")).toBe("failed");
    w.attach();
    w.b.files.accept("week-003");
    await until(() => state(w.b, "in", "week-003") === "cancelled");
    expect(state(w.a, "out", "week-003")).toBe("failed");
  });

  it("an offer still asked about that the sender cancelled or deleted while the receiver was away: back, Accept goes", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    for (const id of ["askgone-1", "askgone-2", "askkeep-1"]) send(w, file(id, 40 * 1024 * 1024));
    await until(() => ["askgone-1", "askgone-2", "askkeep-1"].every((id) => state(w.b, "in", id) === "asking"));
    w.drop();
    w.restart("b");
    w.a.files.cancel("out", "askgone-1");
    w.a.files.forget("out", "askgone-2");
    w.attach();
    await until(() => state(w.b, "in", "askgone-1") === "cancelled" && state(w.b, "in", "askgone-2") === "cancelled");
    expect(w.b.records.get("in:askgone-2")?.error).toBe("Cancelled by the sender");
    // One the sender still offers is still asked about, on both sides.
    await new Promise((r) => setTimeout(r, 50));
    expect(w.b.files.get("in", "askkeep-1")?.state).toBe("asking");
    expect(w.a.files.get("out", "askkeep-1")?.state).toBe("asking");
  });

  it("an offer that expires on the sender's side first, while the session is open, ends on the receiver's too", async () => {
    let now = 1_000;
    const w = wire();
    w.b.decide = async () => "ask";
    for (const side of [w.a, w.b]) (side.files as unknown as { host: ChatFilesHost }).host.now = () => now;
    // Offered while the receiver was away: its week begins when the offer arrives, a day after the sender's.
    w.drop();
    send(w, file("week-004", 40 * 1024 * 1024));
    now += 24 * 60 * 60 * 1000;
    w.attach();
    await until(() => state(w.b, "in", "week-004") === "asking");
    now += FILE_LIMITS.offerTtlMs - 24 * 60 * 60 * 1000 + 1;
    // While the session is open, the sender's sweep says it.
    w.a.files.sweep();
    expect(state(w.a, "out", "week-004")).toBe("failed");
    await until(() => state(w.b, "in", "week-004") === "cancelled");
  });

  it("an offer that expired on the sender's side while the receiver was away: back, Accept goes", async () => {
    let now = 1_000;
    const w = wire();
    w.b.decide = async () => "ask";
    for (const side of [w.a, w.b]) (side.files as unknown as { host: ChatFilesHost }).host.now = () => now;
    w.drop();
    send(w, file("week-006", 40 * 1024 * 1024));
    now += 24 * 60 * 60 * 1000;
    w.attach();
    await until(() => state(w.b, "in", "week-006") === "asking");
    w.drop();
    now += FILE_LIMITS.offerTtlMs - 24 * 60 * 60 * 1000 + 1;
    w.a.files.sweep();
    expect(state(w.a, "out", "week-006")).toBe("failed");
    w.attach();
    await until(() => state(w.b, "in", "week-006") === "cancelled");
  });

  it("the sender pauses, then cancels while the receiver is away: back, the receiver hears it ended and drops what it had", async () => {
    const w = wire();
    w.attach();
    send(w, file("pcancel-1", 4 * 1024 * 1024));
    send(w, file("pkeep-01", 4 * 1024 * 1024));
    await until(() => (w.b.transferred.get("in:pcancel-1") ?? 0) > 100_000 && (w.b.transferred.get("in:pkeep-01") ?? 0) > 100_000);
    w.a.files.pause("out", "pcancel-1");
    w.a.files.pause("out", "pkeep-01");
    await until(() => ["pcancel-1", "pkeep-01"].every((id) => w.b.records.get(`in:${id}`)?.pausedBy === "peer"));
    w.drop();
    w.restart("b");
    w.a.files.cancel("out", "pcancel-1");
    const dataBefore = w.a.sent.filter((f) => f.t === "pf-data" && f.id === "pkeep-01").length;
    w.attach();
    await until(() => state(w.b, "in", "pcancel-1") === "cancelled");
    expect(w.b.records.get("in:pcancel-1")?.error).toBe("Cancelled by the sender");
    await until(() => w.b.disks.get("pcancel-1")!.discarded);
    // One the sender still has paused stays paused on both sides, and nothing moves.
    await new Promise((r) => setTimeout(r, 50));
    expect(w.b.files.get("in", "pkeep-01")).toMatchObject({ state: "paused", pausedBy: "peer" });
    expect(w.a.files.get("out", "pkeep-01")).toMatchObject({ state: "paused", pausedBy: "me" });
    expect(w.a.sent.filter((f) => f.t === "pf-data" && f.id === "pkeep-01").length).toBe(dataBefore);
    expect(w.b.disks.get("pkeep-01")!.discarded).toBe(false);
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

  it("the sender cancels while the receiver still stores what arrived: nothing is stored after it is dropped", async () => {
    // Storage slower than the wire: chunks that arrived wait their turn to be written when the cancel comes.
    const w = wire({ writeMs: 2 });
    w.attach();
    send(w, file("cancel-q", 4 * 1024 * 1024));
    await until(() => (w.b.transferred.get("in:cancel-q") ?? 0) > 100_000);
    w.a.files.cancel("out", "cancel-q");
    await until(() => state(w.b, "in", "cancel-q") === "cancelled");
    const disk = w.b.disks.get("cancel-q")!;
    expect(disk.discarded).toBe(true);
    // Time for any write that was under way or queued to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(disk.length).toBe(0);
  });

  for (const when of ["checking there", "away", "offered again"] as const) {
    it(`a file whose every byte arrived counts as sent whole (${when}): its person's cancel is refused, it ends done on both sides`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const w = wire({ drop: (frame) => when === "offered again" && frame.t === "pf-sum" && w.a.sent.filter((f) => f.t === "pf-sum").length === 1 });
      const disk = new Disk(false);
      let release!: () => void;
      // A large file's digest takes a while to check: the cancel comes meanwhile.
      disk.checking = new Promise<void>((resolve) => { release = resolve; });
      w.b.disks.set("whole-01", disk);
      w.attach();
      send(w, file("whole-01", 3_000_000));
      if (when === "offered again") {
        await until(() => state(w.a, "out", "whole-01") === "verifying");
        await vi.advanceTimersByTimeAsync(FILE_LIMITS.idleMs);
        expect(state(w.a, "out", "whole-01")).toBe("verifying");
      } else await until(() => state(w.b, "in", "whole-01") === "verifying");
      if (when === "away") w.drop();
      // The person's Cancel, as the app takes it.
      if (!sentWhole(w.a.files.get("out", "whole-01")!)) w.a.files.cancel("out", "whole-01");
      expect(state(w.a, "out", "whole-01")).not.toBe("cancelled");
      if (when === "away") w.attach();
      release();
      await until(() => state(w.a, "out", "whole-01") === "done" && state(w.b, "in", "whole-01") === "done");
      expect(disk.discarded).toBe(false);
      expect(w.a.sent.some((f) => f.t === "pf-abort")).toBe(false);
    });
  }

  for (const how of ["Send again", "offered again on its own", "a restart"] as const) {
    it(`an empty file the contact took, offered again (${how}), stays sent whole: its person's cancel is refused, it ends done on both sides`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // The receiver's first answer is lost: it kept the file, the sender still waits to hear so.
      const w = wire({ drop: (frame, from) => from === "b" && frame.t === "pf-done" && w.b.sent.filter((f) => f.t === "pf-done").length === 1 });
      w.attach();
      send(w, file("empty-01", 0));
      await until(() => state(w.b, "in", "empty-01") === "done" && state(w.a, "out", "empty-01") === "verifying");
      if (how === "Send again") w.a.files.resend("empty-01");
      else if (how === "offered again on its own") await vi.advanceTimersByTimeAsync(FILE_LIMITS.idleMs);
      else { w.drop(); w.restart("a"); w.attach(); }
      // Offered again, before the receiver's answer to it: as the app takes the person's Cancel.
      expect(w.a.sent.filter((f) => f.t === "pf-offer")).toHaveLength(how === "a restart" ? 1 : 2);
      expect(w.a.files.get("out", "empty-01")?.state).toBe("verifying");
      if (!sentWhole(w.a.files.get("out", "empty-01")!)) w.a.files.cancel("out", "empty-01");
      await until(() => state(w.a, "out", "empty-01") === "done");
      expect(state(w.b, "in", "empty-01")).toBe("done");
      expect(w.a.sent.some((f) => f.t === "pf-abort")).toBe(false);
    });
  }

  it("a file whose every byte arrived, offered again while the receiver's answer is lost, takes no pause: its cancel stays refused, it ends done on both sides", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The receiver checked it and kept it; its pf-done is lost (a switch, a restart, the receiver gone meanwhile).
    let lose = true;
    const w = wire({ drop: (frame) => lose && frame.t === "pf-done" });
    w.attach();
    send(w, file("whole-03", 300_000));
    await until(() => state(w.b, "in", "whole-03") === "done" && state(w.a, "out", "whole-03") === "verifying");
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.idleMs);
    expect(state(w.a, "out", "whole-03")).toBe("verifying");
    // The person's Pause, then Cancel, as the app takes them.
    w.a.files.pause("out", "whole-03");
    if (!sentWhole(w.a.files.get("out", "whole-03")!)) w.a.files.cancel("out", "whole-03");
    expect(state(w.a, "out", "whole-03")).toBe("verifying");
    lose = false;
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.idleMs);
    await until(() => state(w.a, "out", "whole-03") === "done");
    expect(state(w.b, "in", "whole-03")).toBe("done");
    expect(w.a.sent.some((f) => f.t === "pf-abort")).toBe(false);
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

  it("a channel with a small send budget (native, iroh) never freezes the sender: it waits for room, then goes on", async () => {
    // What froze Miguel's Desktop app on 2026-09-27: a 115 KB voice note over iroh/1. The sixth data frame did not fit
    // the 120 KiB budget, and the sender tried again in a loop of promises that never let the budget drain.
    const w = wire({ keepBytes: true, budget: 120 * 1024, writable: true });
    w.attach();
    send(w, file("voice-115", 115_395));
    await until(() => state(w.a, "out", "voice-115") === "done");
    expect(state(w.b, "in", "voice-115")).toBe("done");
    expect(Uint8Array.from(w.b.disks.get("voice-115")!.bytes!)).toEqual(pattern(0, 115_395));
    expect(w.refusals.a).toBe(0);
  });

  it("a host that does not say when the channel has room: a refused frame is tried again later, not at once", async () => {
    const w = wire({ budget: 120 * 1024 });
    w.attach();
    const size = 2 * 1024 * 1024 + 7;
    send(w, file("budget-2", size));
    await until(() => state(w.a, "out", "budget-2") === "done");
    expect(state(w.b, "in", "budget-2")).toBe("done");
    // One refusal per pause, each followed by a wait: nowhere near a loop.
    expect(w.refusals.a).toBeGreaterThan(0);
    expect(w.refusals.a).toBeLessThanOrEqual(Math.ceil(size / FILE_LIMITS.chunkBytes));
  });

  it("a pump waiting for room on a session that went does not keep the next session's transfer from going", async () => {
    let stuck = true;
    const w = wire({ budget: 120 * 1024, writable: true });
    const host = (w.a.files as unknown as { host: ChatFilesHost }).host;
    const writable = host.writable!;
    // The first session's channel never drains: its pump waits for ever.
    host.writable = () => (stuck ? new Promise<void>(() => {}) : writable());
    w.attach();
    send(w, file("wedged-1", 300_000));
    await until(() => state(w.a, "out", "wedged-1") === "active");
    w.drop();
    stuck = false;
    w.attach();
    await until(() => state(w.a, "out", "wedged-1") === "done");
    expect(state(w.b, "in", "wedged-1")).toBe("done");
  });

  it("Send again: a transfer that stopped moving is offered again, and goes on from the bytes the receiver holds", async () => {
    let lose = true, lost = 0;
    // Data past 1.5 MiB is lost (a session that stopped carrying it) until the test lets it through.
    const w = wire({ drop: (frame, from) => {
      if (!lose || from !== "a" || frame.t !== "pf-data" || (frame.offset as number) < 1.5 * 1024 * 1024) return false;
      lost++;
      return true;
    } });
    w.attach();
    const size = 3 * 1024 * 1024 + 5;
    send(w, file("stall-01", size));
    let sent = -1;
    await until(() => { const now = w.a.sent.length; const still = lost > 0 && now === sent; sent = now; return still; });
    const had = w.b.disks.get("stall-01")!.length;
    expect(had).toBeLessThan(size);
    lose = false;
    const sentBefore = w.a.sent.length;
    expect(w.a.files.resend("stall-01")).toBe(true);
    await until(() => state(w.a, "out", "stall-01") === "done");
    // Done here means the receiver's SHA-256 of what it stored matched.
    expect(state(w.b, "in", "stall-01")).toBe("done");
    // Offered again under the same id; the receiver said where it stood, and nothing below that went again.
    const after = w.a.sent.slice(sentBefore);
    expect(after[0]).toMatchObject({ t: "pf-offer", id: "stall-01" });
    expect(w.b.sent.filter((f) => f.t === "pf-accept").at(-1)!.offset).toBe(had);
    expect(after.filter((f) => f.t === "pf-data" && (f.offset as number) < had)).toEqual([]);
  });

  it("Send again with no session: nothing goes now, and it is offered on the next session", async () => {
    const w = wire();
    send(w, file("offline1", 40_000));
    expect(w.a.files.resend("offline1")).toBe(false);
    w.attach();
    await until(() => state(w.a, "out", "offline1") === "done");
  });

  it("Ask again: a file that stopped arriving is asked for from where it stands here", async () => {
    let lose = true, lost = 0;
    // Data past 1.5 MiB is lost (a session that stopped carrying it) until the test lets it through.
    const w = wire({ drop: (frame, from) => {
      if (!lose || from !== "a" || frame.t !== "pf-data" || (frame.offset as number) < 1.5 * 1024 * 1024) return false;
      lost++;
      return true;
    } });
    w.attach();
    const size = 3 * 1024 * 1024 + 9;
    send(w, file("ask-0001", size));
    let sent = -1;
    await until(() => { const now = w.a.sent.length; const still = lost > 0 && now === sent; sent = now; return still; });
    const had = w.b.disks.get("ask-0001")!.length;
    lose = false;
    const asked = w.b.sent.length;
    expect(w.b.files.request("ask-0001")).toBe(true);
    // The sender is done once the receiver's pf-done reaches it, a turn after the receiver is.
    await until(() => state(w.a, "out", "ask-0001") === "done");
    expect(state(w.b, "in", "ask-0001")).toBe("done");
    expect(w.b.sent.slice(asked).find((f) => f.t === "pf-accept")).toEqual({ t: "pf-accept", id: "ask-0001", offset: had });
    // Nothing to ask for once it is here, or while the person still decides.
    expect(w.b.files.request("ask-0001")).toBe(false);
  });

  it("nothing arriving and the sender not offering again: the receiver asks by itself after a quiet spell", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let lose = true, lost = 0;
    // The sender's own offers again never arrive (an older app, one stuck): only the receiver can put them back in step.
    // Data past 1.5 MiB is lost until the test lets it through.
    const w = wire({ drop: (frame, from) => {
      if (from !== "a") return false;
      if (frame.t === "pf-offer") return w.a.sent.filter((f) => f.t === "pf-offer").length > 1;
      if (lose && frame.t === "pf-data" && (frame.offset as number) >= 1.5 * 1024 * 1024) { lost++; return true; }
      return false;
    } });
    w.attach();
    send(w, file("nudge-01", 3 * 1024 * 1024));
    // Until the sender has filled its window and waits: nothing moves on its own now.
    let sent = -1;
    await until(() => { const now = w.a.sent.length; const still = lost > 0 && now === sent; sent = now; return still; });
    lose = false;
    const accepts = w.b.sent.filter((f) => f.t === "pf-accept").length;
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.idleMs + 10);
    await until(() => state(w.a, "out", "nudge-01") === "done");
    expect(w.b.sent.filter((f) => f.t === "pf-accept").length).toBeGreaterThan(accepts);
  });

  it("a sender that could not read its file stops it; sent again, the receiver takes it again, while one it cancelled stays so", async () => {
    const w = wire({ keepBytes: true });
    w.attach();
    let unreadable = true;
    const src = source(200_000);
    w.a.sources.set("reread-1", { read: (offset, length) => (unreadable ? Promise.reject(new Error("The object can not be found here.")) : src.read(offset, length)), digest: () => src.digest() });
    w.a.files.offer(file("reread-1", 200_000));
    await until(() => state(w.b, "in", "reread-1") === "cancelled");
    expect(w.a.records.get("out:reread-1")).toMatchObject({ state: "failed", error: "Could not read the file: The object can not be found here." });
    unreadable = false;
    expect(w.a.files.resend("reread-1")).toBe(true);
    await until(() => state(w.a, "out", "reread-1") === "done");
    expect(Uint8Array.from(w.b.disks.get("reread-1")!.bytes!)).toEqual(pattern(0, 200_000));

    // The receiver's own cancel is final: offered again, it is refused.
    w.b.decide = async () => "ask";
    send(w, file("mine-001", 50_000));
    await until(() => state(w.b, "in", "mine-001") === "asking");
    w.b.files.cancel("in", "mine-001");
    await until(() => state(w.a, "out", "mine-001") === "cancelled");
    expect(w.a.files.resend("mine-001")).toBe(false);
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

  /**
   * A sender facing a receiver that is not the app: it confirms every byte, and answers each `pf-sum` with
   * `pf-accept {offset: 0}` instead of `pf-done`, `laps` times at most.
   */
  function rewound(size: number, laps: number, resend?: ChatFilesHost["resend"]) {
    const seen = { data: 0, sums: 0, aborts: 0, record: undefined as FileTransferRecord | undefined };
    const src = source(size);
    const files: ChatFiles = new ChatFiles({
      send: (frame) => {
        const answer = (reply: Record<string, unknown>) => setImmediate(() => void files.handle({ ...reply, id: frame.id }));
        if (frame.t === "pf-offer") answer({ t: "pf-accept", offset: 0 });
        else if (frame.t === "pf-data") { const bytes = Buffer.from(frame.data as string, "base64url").length; seen.data += bytes; answer({ t: "pf-got", offset: (frame.offset as number) + bytes }); }
        else if (frame.t === "pf-sum") { if (++seen.sums <= laps) answer({ t: "pf-accept", offset: 0 }); }
        else if (frame.t === "pf-abort") seen.aborts++;
        return true;
      },
      decide: async () => "accept",
      openTarget: async () => { throw new Error("nothing is received here"); },
      openSource: async () => src,
      changed: (record) => { seen.record = record; },
      ...(resend && { resend }),
    });
    files.attach();
    return { files, seen };
  }

  it("a receiver that asks for a file from the start again and again is sent a bounded part of it again, then the sender ends it", async () => {
    const limits = FILE_LIMITS as { -readonly [K in keyof typeof FILE_LIMITS]: number }, before = limits.resendBytes;
    limits.resendBytes = 2 * FILE_LIMITS.chunkBytes;
    try {
      const size = 8 * FILE_LIMITS.chunkBytes, { files, seen } = rewound(size, 50);
      files.offer(file("rewind-0001", size));
      await until(() => seen.record && seen.record.state !== "active" && seen.record.state !== "verifying" && seen.record.state !== "offered" && seen.record.state !== "queued" || seen.sums > 50);
      // The file once, then twice its size and `resendBytes` again: nothing after that, and the receiver hears it ended.
      expect(seen.data).toBe(3 * size + limits.resendBytes);
      expect(seen.record).toMatchObject({ state: "failed", error: "Your contact asked for the same part of this file too many times" });
      expect(seen.aborts).toBe(1);
      expect(files.sent("rewind-0001")).toBe(seen.data);
    } finally { limits.resendBytes = before; }
  });

  it("a host with a budget for what it sends is asked before a part goes again, and its no ends the transfer", async () => {
    const size = 8 * FILE_LIMITS.chunkBytes, asked: number[] = [];
    // One lap again is fine with this host; the next byte is not.
    const { files, seen } = rewound(size, 50, (record, sent) => { asked.push(sent); return record.id === "budget-0001" && sent <= 2 * size; });
    files.offer(file("budget-0001", size));
    await until(() => seen.record?.state === "failed" || seen.sums > 50);
    expect(seen.data).toBe(2 * size);
    expect(seen.record?.state).toBe("failed");
    expect(seen.aborts).toBe(1);
    // Never asked within the file's size: an ordinary transfer does not pass through the host's budget.
    expect(Math.min(...asked)).toBe(size + FILE_LIMITS.chunkBytes);
  });

  it("a receiver that asks for an earlier part a few times (a restart, a drop) still gets the whole file", async () => {
    const size = 8 * FILE_LIMITS.chunkBytes, { files, seen } = rewound(size, 2);
    files.offer(file("again-0001", size));
    await until(() => seen.sums === 3);
    await files.handle({ t: "pf-done", id: "again-0001" });
    expect(seen.record?.state).toBe("done");
    expect(files.sent("again-0001")).toBe(3 * size);
    expect(seen.aborts).toBe(0);
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

  it("the session drops after the file checked out there: on the next one the sender hears so and ends it done", async () => {
    let lose = true;
    const w = wire({ drop: (frame) => lose && frame.t === "pf-done" });
    w.attach();
    send(w, file("sum-0001", 50_000));
    await until(() => state(w.b, "in", "sum-0001") === "done");
    lose = false;
    w.drop(); w.attach();
    await until(() => state(w.a, "out", "sum-0001") === "done");
  });

  for (const back of ["after", "before"] as const) {
    it(`the session drops while the receiver checks the digest, which ends ${back} it is back: the file ends done on both sides`, async () => {
      const w = wire();
      const disk = new Disk(false);
      let release!: () => void;
      disk.checking = new Promise<void>((resolve) => { release = resolve; });
      w.b.disks.set("chk-0001", disk);
      w.attach();
      send(w, file("chk-0001", 50_000));
      await until(() => state(w.b, "in", "chk-0001") === "verifying");
      w.drop();
      if (back === "before") { release(); await until(() => state(w.b, "in", "chk-0001") === "done"); }
      w.attach();
      if (back === "after") release();
      await until(() => state(w.a, "out", "chk-0001") === "done");
      expect(state(w.b, "in", "chk-0001")).toBe("done");
    });
  }

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

  it.each(["ENOSPC", "EDQUOT"])("a write the disk had no room for (Node's %s, as the CLI's file bytes pass it up) is stored as no room", async (code) => {
    const id = `${code.toLowerCase()}-01`;
    const w = wire();
    w.attach();
    send(w, file(id, 2 * 1024 * 1024));
    await until(() => w.b.disks.has(id));
    const disk = w.b.disks.get(id)!;
    disk.failWith = Object.assign(new Error(`${code}: no space left on device, write`), { code, errno: -28, syscall: "write" });
    disk.failAt = 500_000;
    await until(() => state(w.b, "in", id) === "failed");
    // Told by the error's code, never its words: named QuotaExceededError, as the app's matcher and the CLI read it.
    expect(w.b.records.get(`in:${id}`)?.error).toBe(`Could not store the file: QuotaExceededError: ${code}: no space left on device, write`);
    expect(w.b.sent).toContainEqual({ t: "pf-refuse", id, why: "no-room" });
    expect(disk.discarded).toBe(true);
  });

  it("a write that failed for another reason (EIO, or words that only mention ENOSPC) keeps its words", async () => {
    const w = wire();
    w.attach();
    send(w, file("eio-0001", 2 * 1024 * 1024));
    await until(() => w.b.disks.has("eio-0001"));
    const disk = w.b.disks.get("eio-0001")!;
    disk.failWith = Object.assign(new Error("EIO: i/o error, write (not ENOSPC)"), { code: "EIO", syscall: "write" });
    disk.failAt = 500_000;
    await until(() => state(w.b, "in", "eio-0001") === "failed");
    expect(w.b.records.get("in:eio-0001")?.error).toBe("Could not store the file: EIO: i/o error, write (not ENOSPC)");
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

  it("a file waiting its turn is told so once, not again each time another one ends", async () => {
    // Told again for every file still waiting whenever one ended: n files at once made about n²/2 frames, and the
    // sender stored its record for each.
    const w = wire();
    w.attach();
    const n = 30;
    for (let i = 0; i < n; i++) send(w, file(`turn-${String(i).padStart(3, "0")}`, 4 * 1024));
    await until(() => [...w.a.records.values()].length === n && [...w.a.records.values()].every((r) => r.state === "done"), 30_000);
    const told = new Map<string, number>();
    for (const frame of w.b.sent) if (frame.t === "pf-wait" && frame.why === "busy") told.set(frame.id as string, (told.get(frame.id as string) ?? 0) + 1);
    expect(told.size).toBeGreaterThan(0);
    expect(Math.max(...told.values())).toBe(1);
  });

  it("the sender stores a wait it was already told nothing new", async () => {
    const w = wire();
    w.b.decide = async () => "ask";
    w.attach();
    send(w, file("told-twice", 4 * 1024));
    await until(() => w.a.records.get("out:told-twice")?.waitingFor === "consent");
    const before = w.a.stateChanges;
    await w.a.files.handle({ t: "pf-wait", id: "told-twice", why: "consent" });
    expect(w.a.stateChanges).toBe(before);
    await w.a.files.handle({ t: "pf-wait", id: "told-twice", why: "busy" });
    expect(w.a.records.get("out:told-twice")?.waitingFor).toBe("busy");
    await w.a.files.handle({ t: "pf-wait", id: "told-twice", why: "busy" });
    expect(w.a.stateChanges).toBe(before + 1);
  });

  it("files sent all at once still arrive three at a time when opening where each is written takes a while", async () => {
    // Opening a received file reads the database first: the offers behind it, and the files queued behind one that
    // ended, came in meanwhile and each went, until ten sent 1 MiB windows at once and the session's receive queue
    // overflowed.
    const w = wire({ openMs: 5 });
    w.attach();
    let sending = 0, receiving = 0;
    const sample = setInterval(() => {
      sending = Math.max(sending, [...w.a.records.values()].filter((r) => r.state === "active").length);
      receiving = Math.max(receiving, [...w.b.records.values()].filter((r) => r.state === "active" || r.state === "verifying").length);
    }, 0);
    try {
      for (let i = 0; i < 10; i++) send(w, file(`burst-0${i}`, 256 * 1024));
      await until(() => [...w.a.records.values()].length === 10 && [...w.a.records.values()].every((r) => r.state === "done"), 30_000);
    } finally { clearInterval(sample); }
    expect(receiving).toBeLessThanOrEqual(FILE_LIMITS.maxActiveIncoming);
    expect(sending).toBeLessThanOrEqual(FILE_LIMITS.maxActiveIncoming);
  });

  it("what a chat's files have sent and not seen confirmed stays within one window for them all", async () => {
    // Three files at once with a 1 MiB window each were 3 MiB in flight, and as base64 text more than a session's
    // receive queue takes (`SESSION_RECEIVE_PENDING`): a receiver that stalled a moment ended the session.
    const w = wire({ writeMs: 1 });
    w.attach();
    const sizes = new Map<string, number>();
    for (let i = 0; i < 3; i++) { sizes.set(`shared-0${i}`, 3 * 1024 * 1024); send(w, file(`shared-0${i}`, 3 * 1024 * 1024)); }
    let most = 0;
    const sample = setInterval(() => {
      let total = 0;
      for (const id of sizes.keys()) {
        const sent = w.a.sent.filter((f) => f.t === "pf-data" && f.id === id).reduce((end, f) => Math.max(end, (f.offset as number) + FILE_LIMITS.chunkBytes), 0);
        total += Math.max(0, Math.min(sent, sizes.get(id)!) - (w.a.records.get(`out:${id}`)?.confirmed ?? 0));
      }
      most = Math.max(most, total);
    }, 0);
    try {
      await until(() => [...sizes.keys()].every((id) => state(w.a, "out", id) === "done"), 60_000);
    } finally { clearInterval(sample); }
    expect(most).toBeGreaterThan(FILE_LIMITS.windowBytes);
    expect(most).toBeLessThanOrEqual(FILE_LIMITS.chatWindowBytes);
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

  it("a contact's files not finished here are counted, not only their bytes: past the limit an offer of 0 bytes is refused", async () => {
    // Every offer of 0 bytes was taken (only bytes were counted): 2,500 of them were 2,500 messages and records here.
    const w = wire();
    w.attach();
    const offer = (id: string) => w.b.files.handle({ t: "pf-offer", id, name: `${id}.txt`, mime: "text/plain", size: 0, ts: 1_700_000_000_000 });
    const extra = 40;
    for (let i = 0; i < FILE_LIMITS.maxUnfinishedIncoming + extra; i++) await offer(`flood-${String(i).padStart(4, "0")}`);
    const unfinished = () => [...w.b.records.values()].filter((r) => r.direction === "in" && !["done", "failed", "declined", "cancelled"].includes(r.state)).length;
    expect(unfinished()).toBe(FILE_LIMITS.maxUnfinishedIncoming);
    expect(w.b.records.size).toBe(FILE_LIMITS.maxUnfinishedIncoming);
    expect(w.b.sent.filter((f) => f.t === "pf-refuse" && f.why === "too-many")).toHaveLength(extra);
    // One the sender stopped, offered again, is taken again only within the limit too.
    await w.b.files.handle({ t: "pf-abort", id: "flood-0100" });
    expect(state(w.b, "in", "flood-0100")).toBe("cancelled");
    await offer("flood-new1");
    expect(state(w.b, "in", "flood-new1")).toBe("queued");
    w.b.sent.length = 0;
    await offer("flood-0100");
    expect(w.b.sent).toEqual([{ t: "pf-refuse", id: "flood-0100", why: "too-many" }]);
    expect(state(w.b, "in", "flood-0100")).toBe("cancelled");
    expect(unfinished()).toBe(FILE_LIMITS.maxUnfinishedIncoming);
  });

  it("a file taken here that waits its turn and never arrives ends after a week; offered again, it is taken again", async () => {
    let now = 1_000;
    const w = wire();
    (w.b.files as unknown as { host: ChatFilesHost }).host.now = () => now;
    w.attach();
    const offer = (id: string, size = 0) => w.b.files.handle({ t: "pf-offer", id, name: `${id}.txt`, mime: "text/plain", size, ts: 1_700_000_000_000 });
    // Three take the turns; a sender that never sends leaves the fourth waiting.
    for (let i = 0; i < 4; i++) await offer(`stuck-00${i}`);
    await until(() => [...w.b.records.values()].filter((r) => r.state === "active").length === 3);
    expect(state(w.b, "in", "stuck-003")).toBe("queued");
    // One the person accepted late, waiting its turn too: its week starts with the answer.
    w.b.decide = async () => "ask";
    await offer("late-0001", 40 * 1024 * 1024);
    expect(state(w.b, "in", "late-0001")).toBe("asking");
    now += FILE_LIMITS.offerTtlMs - 1_000;
    w.b.files.accept("late-0001");
    expect(state(w.b, "in", "late-0001")).toBe("queued");
    now += 2_000;
    w.b.sent.length = 0;
    w.b.files.sweep();
    expect(state(w.b, "in", "stuck-003")).toBe("failed");
    expect(w.b.records.get("in:stuck-003")?.error).toBe("The offer expired");
    expect(w.b.sent).toContainEqual({ t: "pf-refuse", id: "stuck-003", why: "expired" });
    expect(state(w.b, "in", "late-0001")).toBe("queued");
    w.b.decide = async () => "accept";
    await offer("stuck-003");
    expect(state(w.b, "in", "stuck-003")).toBe("queued");
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

  it("an offer that expired unanswered, offered again, is refused: never taken without asking", async () => {
    let now = 1_000;
    const w = wire();
    const asked: string[] = [];
    w.b.decide = async (f) => { asked.push(f.id); return "ask"; };
    for (const side of [w.a, w.b]) (side.files as unknown as { host: ChatFilesHost }).host.now = () => now;
    w.attach();
    send(w, file("week-002", 40 * 1024 * 1024));
    await until(() => state(w.b, "in", "week-002") === "asking");
    now += FILE_LIMITS.offerTtlMs + 1;
    w.b.files.sweep();
    await until(() => state(w.b, "in", "week-002") === "failed");
    // The same pf-offer again (same id, name and size), as a sender replaying it would.
    const offer = w.a.sent.find((f) => f.t === "pf-offer" && f.id === "week-002")!;
    w.b.sent.length = 0;
    await w.b.files.handle({ ...offer });
    expect(w.b.sent).toEqual([{ t: "pf-refuse", id: "week-002", why: "expired" }]);
    expect(state(w.b, "in", "week-002")).toBe("failed");
    expect(w.b.disks.has("week-002"), "nothing was written").toBe(false);
    expect(asked).toEqual(["week-002"]);
  });

  it("a file taken within the limits that failed here is taken again from the start when offered again", async () => {
    const w = wire();
    w.attach();
    send(w, file("full-002", 2 * 1024 * 1024));
    await until(() => w.b.disks.has("full-002"));
    w.b.disks.get("full-002")!.failAt = 500_000;
    await until(() => state(w.b, "in", "full-002") === "failed");
    expect(w.b.records.get("in:full-002")?.agreed).toBe(true);
    w.b.disks.get("full-002")!.failAt = Infinity;
    w.a.sources.set("full-002", source(2 * 1024 * 1024));
    await until(() => state(w.a, "out", "full-002") === "failed");
    w.a.files.retry("full-002");
    await until(() => state(w.b, "in", "full-002") === "done");
  });

  it("a file taken without asking, offered again after it ended, is decided again: past the limits it is asked about", async () => {
    const w = wire();
    w.attach();
    send(w, file("over-001", 2 * 1024 * 1024));
    await until(() => w.b.disks.has("over-001"));
    w.b.disks.get("over-001")!.failAt = 500_000;
    await until(() => state(w.b, "in", "over-001") === "failed");
    expect(w.b.records.get("in:over-001")?.agreed).toBe(true);
    // Since then the contact used up what may be taken without asking: the same offer again is a question.
    const again: [string, boolean | undefined][] = [];
    w.b.decide = async (f, a) => { again.push([f.id, a]); return "ask"; };
    const offer = w.a.sent.find((f) => f.t === "pf-offer" && f.id === "over-001")!;
    w.b.sent.length = 0;
    await w.b.files.handle({ ...offer });
    expect(again).toEqual([["over-001", true]]);
    expect(state(w.b, "in", "over-001")).toBe("asking");
    expect(w.b.sent).toEqual([{ t: "pf-wait", id: "over-001", why: "consent" }]);
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

describe("when a transfer counts as stuck", () => {
  const at = 1_000_000;
  const record = (over: Partial<FileTransferRecord>): FileTransferRecord => ({ id: "stuck-01", direction: "out", file: file("stuck-01", 1000), state: "active", confirmed: 0, since: 0, ...over });
  it.each<[string, Partial<FileTransferRecord>, number, boolean, boolean]>([
    ["moving", {}, at - 1_000, false, false],
    ["quiet for the stall time", {}, at - FILE_LIMITS.stallMs, false, true],
    ["kept from before a restart, not moved since", {}, at, true, true],
    ["waiting for a session, quiet", { state: "queued" }, at - FILE_LIMITS.stallMs, false, true],
    ["sent whole, the receiver never said it checked out", { state: "verifying" }, at - FILE_LIMITS.stallMs, false, true],
    ["received whole and being checked here", { state: "verifying", direction: "in" }, at - FILE_LIMITS.stallMs, true, false],
    ["the contact decides", { state: "asking" }, 0, true, false],
    ["paused", { state: "paused", pausedBy: "peer" }, 0, true, false],
    ["failed (it has Retry)", { state: "failed" }, 0, true, false],
    ["done", { state: "done" }, 0, true, false],
  ])("%s", (_, over, movedAt, restored, stuck) => {
    expect(transferStalled(record(over), movedAt, restored, at)).toBe(stuck);
  });
  it("waits longer than the automatic offer again, so that goes first", () => {
    expect(FILE_LIMITS.stallMs).toBeGreaterThan(FILE_LIMITS.idleMs);
  });
});

describe("when a sent file is too late to cancel", () => {
  const record = (over: Partial<FileTransferRecord>): FileTransferRecord => ({ id: "whole-02", direction: "out", file: file("whole-02", 1000), state: "active", confirmed: 1000, since: 0, ...over });
  it.each<[string, Partial<FileTransferRecord>, boolean]>([
    ["the receiver checks it", { state: "verifying" }, true],
    ["every byte confirmed, offered again", { state: "offered" }, true],
    ["every byte confirmed, waiting for a session", { state: "queued" }, true],
    ["an empty file checked there", { state: "verifying", file: file("whole-02", 0), confirmed: 0 }, true],
    ["bytes still to go", { confirmed: 999 }, false],
    ["an empty file not answered yet", { state: "offered", file: file("whole-02", 0), confirmed: 0 }, false],
    ["the receiver asks about it again", { state: "asking", waitingFor: "consent" }, false],
    ["paused here", { state: "paused", pausedBy: "me" }, false],
    ["received", { state: "verifying", direction: "in" }, false],
    ["done", { state: "done" }, false],
  ])("%s", (_, over, whole) => {
    expect(sentWhole(record(over))).toBe(whole);
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
    // What is held, not garbage not collected yet: that depends on when the collector runs (and on what the tests
    // before this one left), and swung from 23 to 115 MiB between runs of the same code.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    gc();
    const base = process.memoryUsage();
    let peak = 0;
    const sample = setInterval(() => {
      gc();
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 250);
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
