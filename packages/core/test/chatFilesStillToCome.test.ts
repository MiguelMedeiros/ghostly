import { describe, expect, it, vi } from "vitest";
import { ChatFiles, FILE_LIMITS, transferEnded, type ChatFilesHost, type FileTransferRecord, type IncomingTarget, type OfferDecision, type TransferState } from "../src/chatFiles";
// covers: files.large.offer, files.large.limits

/**
 * An offer read what is still to come, and whether anything is under way, by copying every record the chat ever had:
 * finished ones are kept for good, so each offer cost more with every file the profile ever sent or received (about
 * 10 ms at 200 chats of 500 files). ChatFiles now keeps the entries not ended as they change. Whatever happens to the
 * records, what it answers must stay what the old reading of every record answered.
 */

/** The old readings, over a copy of every record (FileDesk's `stillComing`, `moving` and `autoTaken` before). */
const old = {
  stillToCome: (records: FileTransferRecord[]) => records.filter((r) => r.direction === "in" && r.state !== "asking" && !transferEnded(r))
    .reduce((due, r) => due + Math.max(0, r.file.size - r.confirmed), 0),
  underWay: (records: FileTransferRecord[]) => records.some((r) => r.state === "offered" || r.state === "active" || r.state === "verifying"),
  takenUnasked: (records: FileTransferRecord[]) => records.filter((r) => r.direction === "in" && !r.consented && r.state !== "asking" && !["failed", "declined", "cancelled"].includes(r.state))
    .reduce((sum, r) => sum + r.file.size, 0),
};

/** Small deterministic generator: a failing seed runs the same course again. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(items: readonly T[]): T => items[int(items.length)] };
}

const STATES: TransferState[] = ["queued", "offered", "asking", "active", "paused", "verifying", "done", "failed", "declined", "cancelled"];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function chat(seed: number) {
  const rnd = random(seed);
  let clock = 1_700_000_000_000;
  const host: ChatFilesHost = {
    send: () => true,
    decide: async (): Promise<OfferDecision> => rnd.pick<OfferDecision>(["accept", "accept", "ask", { refuse: "no-room" }]),
    openTarget: async (): Promise<IncomingTarget> => {
      if (rnd.next() < 0.1) throw new Error("disk full");
      return { offset: 0, append: async () => {}, flush: async () => {}, verify: async () => rnd.next() < 0.7, discard: async () => {} };
    },
    openSource: async (record) => ({ read: async (offset, length) => new Uint8Array(Math.max(0, Math.min(length, record.file.size - offset))), digest: async () => "A".repeat(43) }),
    changed: () => {},
    now: () => clock,
  };
  const files = new ChatFiles(host);
  const ids = { in: [] as string[], out: [] as string[] };
  const newId = () => `f${seed}x${ids.in.length + ids.out.length}`.padEnd(10, "0");
  const info = (id: string, size: number) => ({ id, name: `${id}.bin`, mime: "application/octet-stream", size, timestamp: 1 });

  // What a profile brings from before: records in every state, both ways, taken with and without asking.
  const restored: FileTransferRecord[] = [];
  for (let i = 0; i < 30; i++) {
    const direction = rnd.pick(["in", "out"] as const), id = newId(), size = rnd.int(300_000);
    ids[direction].push(id);
    restored.push({ id, direction, file: info(id, size), state: rnd.pick(STATES), confirmed: rnd.int(size + 1), since: clock - rnd.int(FILE_LIMITS.offerTtlMs * 2),
      ...(rnd.next() < 0.5 && { consented: true }), ...(rnd.next() < 0.5 && { agreed: true }), ...(rnd.next() < 0.3 && { abortedBySender: true }),
      ...(rnd.next() < 0.3 && { pausedBy: rnd.pick(["me", "peer"] as const) }) });
  }
  files.restore(restored);

  const sizeOf = (direction: "in" | "out", id: string) => files.get(direction, id)?.file.size ?? rnd.int(300_000);
  const steps: (() => unknown)[] = [
    () => files.attach(),
    () => files.detach(),
    () => { const id = newId(); ids.out.push(id); files.offer(info(id, rnd.int(300_000))); },
    () => { const id = newId(); ids.in.push(id); return files.handle({ t: "pf-offer", id, name: `${id}.bin`, mime: "application/octet-stream", size: rnd.int(300_000), ts: 1, ...(rnd.next() < 0.2 && { paused: true }) }); },
    // Offered again: taken again, refused, or picked up where it stands.
    () => { const id = rnd.pick(ids.in); return id && files.handle({ t: "pf-offer", id, name: `${id}.bin`, mime: "application/octet-stream", size: sizeOf("in", id), ts: 1, ...(rnd.next() < 0.2 && { paused: true }) }); },
    () => { const id = rnd.pick(ids.in); const at = files.get("in", id)?.confirmed ?? 0; return id && files.handle({ t: "pf-data", id, offset: at, data: new Uint8Array(Math.max(1, Math.min(FILE_LIMITS.chunkBytes, sizeOf("in", id) - at))) }); },
    () => { const id = rnd.pick(ids.in); return id && files.handle({ t: "pf-sum", id, size: sizeOf("in", id), digest: "A".repeat(43) }); },
    () => { const id = rnd.pick(ids.in); return id && files.handle({ t: "pf-abort", id }); },
    () => { const id = rnd.pick(ids.out); return id && files.handle({ t: "pf-accept", id, offset: rnd.int(sizeOf("out", id) + 1) }); },
    () => { const id = rnd.pick(ids.out); return id && files.handle({ t: "pf-wait", id, why: rnd.pick(["busy", "consent", "paused"]) }); },
    () => { const id = rnd.pick(ids.out); return id && files.handle({ t: "pf-got", id, offset: rnd.int(sizeOf("out", id) + 1) }); },
    () => { const id = rnd.pick(ids.out); return id && files.handle({ t: "pf-done", id }); },
    () => { const id = rnd.pick(ids.out); return id && files.handle({ t: "pf-refuse", id, why: rnd.pick(["declined", "no-room", "cancelled", "expired", "damaged", "too-many"]) }); },
    () => { const id = rnd.pick(ids.in); if (id) files.accept(id); },
    () => { const id = rnd.pick(ids.in); if (id) files.decline(id); },
    () => { const id = rnd.pick(ids.in); if (id) files.refuse(id, "invalid"); },
    () => { const id = rnd.pick(ids.in); if (id) files.request(id); },
    () => { const id = rnd.pick(ids.out); if (id) files.retry(id); },
    () => { const id = rnd.pick(ids.out); if (id) files.resend(id); },
    () => { const direction = rnd.pick(["in", "out"] as const), id = rnd.pick(ids[direction]); if (id) files.pause(direction, id); },
    () => { const direction = rnd.pick(["in", "out"] as const), id = rnd.pick(ids[direction]); if (id) files.resume(direction, id); },
    () => { const direction = rnd.pick(["in", "out"] as const), id = rnd.pick(ids[direction]); if (id) files.cancel(direction, id); },
    () => { const direction = rnd.pick(["in", "out"] as const), id = rnd.pick(ids[direction]); if (id) files.forget(direction, id); },
    () => { clock += rnd.pick([1000, FILE_LIMITS.offerTtlMs + 1]); files.sweep(); },
  ];
  /** One step, its id picked among the chat's (one forgotten or refused included: it throws, as for the app). */
  const step = () => {
    try { return rnd.pick(steps)(); } catch { return undefined; }
  };
  return { files, step, rnd };
}

function same(files: ChatFiles): void {
  const records = files.records();
  expect(files.stillToCome()).toBe(old.stillToCome(records));
  expect(files.underWay()).toBe(old.underWay(records));
  expect(files.takenUnasked()).toBe(old.takenUnasked(records));
  // Exactly the entries not ended: one left behind would make every read cost more again.
  expect((files as unknown as { unended: Set<unknown> }).unended.size).toBe(records.filter((r) => !transferEnded(r)).length);
}

describe("ChatFiles keeps the files not ended as they change", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("answers as a reading of every record would, step after step (seed %i)", async (seed) => {
    const { files, step, rnd } = chat(seed);
    same(files);
    let ended = 0;
    const under: unknown[] = [];
    for (let i = 0; i < 400; i++) {
      under.push(step());
      // Right after the call, before what it started goes on; now and then the next step comes while it still does.
      same(files);
      if (rnd.next() < 0.3) continue;
      await Promise.all(under.splice(0).map((running) => Promise.resolve(running).catch(() => {})));
      await flush();
      same(files);
      ended = Math.max(ended, files.records().filter(transferEnded).length);
    }
    files.detach();
    // The course went through files ending, not only through ones under way.
    expect(ended).toBeGreaterThan(5);
  });

  it("leaves out a file forgotten while its offer again was being decided", async () => {
    const decided: ((decision: OfferDecision) => void)[] = [];
    const files = new ChatFiles({
      send: () => true,
      decide: () => new Promise<OfferDecision>((resolve) => decided.push(resolve)),
      openTarget: () => new Promise<IncomingTarget>(() => {}),
      openSource: async () => { throw new Error("not sending"); },
      changed: () => {},
    });
    const file = { id: "wForgotten1", name: "a.bin", mime: "application/octet-stream", size: 1000, timestamp: 1 };
    files.restore([{ id: file.id, direction: "in", file, state: "failed", confirmed: 0, since: Date.now(), agreed: true }]);
    files.attach();
    const offered = files.handle({ t: "pf-offer", id: file.id, name: file.name, mime: file.mime, size: file.size, ts: 1 });
    await vi.waitFor(() => expect(decided).toHaveLength(1));
    // Its message deleted meanwhile: the file is gone from the chat, and stays gone once it is taken again.
    files.forget("in", file.id);
    decided[0]("accept");
    await offered;
    expect(files.records()).toEqual([]);
    same(files);
    expect(files.stillToCome()).toBe(0);
    files.detach();
  });
});
