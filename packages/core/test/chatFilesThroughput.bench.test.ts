import { afterAll, afterEach, describe, it } from "vitest";
import { ChatFiles, FILE_LIMITS, type ChatFilesHost, type FileTransferRecord } from "../src/chatFiles";
import type { FileInfo } from "../src/files";
// covers: files.large.limits

/**
 * Throughput benchmark of one file between two `ChatFiles` over a modelled path, on a clock of its own: a bottleneck
 * of `upBytesPerMs`, `delayMs` each way, and `jitterMs` of extra delay per frame each way (a stream keeps its order, so a
 * frame never passes the one before it). `writeMs`: what the receiver's storage takes per append. Once a second the
 * sender says something else in the chat: how long that takes behind the file is the price of its speed.
 * Prints a table of every mode and path, and second by second for the runs `VERBOSE` names.
 */
type Path = { name: string; size: number; upBytesPerMs: number; delayMs: number; jitterMs: number; wanderMs?: number; writeMs?: number; seconds?: number };

function prng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

async function run(path: Path, mode: string) {
  let now = 0, upFree = 0, lastAtB = 0, lastAtA = 0, writeFree = 0;
  const random = prng(1798);
  // `wanderMs`: the extra delay wanders (a radio's scheduling, a relay's load), a new level every `wanderMs`, the same
  // for every frame meanwhile; else each frame draws its own.
  let level = 0, levelAt = -Infinity;
  const jitter = () => {
    if (!path.wanderMs) return random() * path.jitterMs;
    if (now - levelAt >= path.wanderMs) { level = random() * path.jitterMs; levelAt = now; }
    return level;
  };
  const events: { at: number; to: "a" | "b"; frame: Record<string, unknown> }[] = [];
  const schedule = (event: (typeof events)[number]) => {
    let i = events.length;
    while (i && events[i - 1].at > event.at) i--;
    events.splice(i, 0, event);
  };
  const toB = (frame: Record<string, unknown>, bytes: number) => {
    upFree = Math.max(now, upFree) + bytes / path.upBytesPerMs;
    lastAtB = Math.max(lastAtB, upFree + path.delayMs + jitter());
    schedule({ at: lastAtB, to: "b", frame });
  };
  const toA = (frame: Record<string, unknown>) => {
    lastAtA = Math.max(lastAtA, now + path.delayMs + jitter());
    schedule({ at: lastAtA, to: "a", frame });
  };
  const records = new Map<string, FileTransferRecord>();
  const host = (name: "a" | "b"): ChatFilesHost => ({
    send: (frame) => { const copy = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>; if (name === "a") toB(copy, JSON.stringify(frame).length); else toA(copy); return true; },
    sendData: (id, offset, data) => { toB({ t: "pf-data", id, offset, data: Buffer.from(data).toString("base64url") }, data.length + 32); return true; },
    decide: async () => "accept",
    openTarget: async () => ({
      offset: 0,
      append: async () => {
        if (!path.writeMs) return;
        writeFree = Math.max(now, writeFree) + path.writeMs;
        const until = writeFree;
        await new Promise<void>((resolve) => waiters.push({ at: until, resolve }));
      },
      flush: async () => {}, verify: async () => true, discard: async () => {},
    }),
    openSource: async () => ({ read: async (offset, length) => new Uint8Array(Math.min(length, path.size - offset)), digest: async () => "A".repeat(43) }),
    changed: (record) => { records.set(`${record.direction}:${record.id}`, record); },
    now: () => now,
  });
  const waiters: { at: number; resolve: () => void }[] = [];
  const a = new ChatFiles(host("a")), b = new ChatFiles(host("b"));
  a.attach(); b.attach();
  const info: FileInfo = { id: "bench-file-1", name: "big.bin", mime: "application/octet-stream", size: path.size, timestamp: 1 };
  a.offer(info);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  type Round = { rate: number; rtt: number };
  type Trial = { window: number; before: Round };
  const pace = (a as unknown as { pace: { window: number; base: number; held: number; last: Round; trial?: Trial; limit(floor: number): number; tried(...args: unknown[]): void } }).pace;
  const perSecond: { s: number; bytes: number; window: number; limit: number; base: number; held: number }[] = [];
  // The rate trials of the runs `VERBOSE` names, as they start and end.
  if (VERBOSE.test(`${mode}: ${path.name}`)) {
    const tried = pace.tried.bind(pace);
    pace.tried = (...args: unknown[]) => {
      const before = pace.trial;
      tried(...args);
      const round = (r: Round) => `${((r.rate * 1000) / MiB).toFixed(2)} MiB/s, ${Math.round(r.rtt)} ms`;
      if (before && before !== pace.trial) console.info(`${(now / 1000).toFixed(2)}s trial of ${kib(before.window)}: ${round(pace.last)}, held ${kib(pace.held)}`);
      if (pace.trial && pace.trial !== before) console.info(`${(now / 1000).toFixed(2)}s trial of ${kib(pace.trial.window)} from ${round(pace.trial.before)}`);
    };
  }
  let confirmed = 0, lastConfirmed = 0, nextTick = 1_000, nextSay = 1_500, started = -1, finished = -1;
  /** How long a text the sender says once a second, behind the file, takes to arrive. */
  const texts: number[] = [];
  const end = (path.seconds ?? 120) * 1000;
  try {
    for (;;) {
      await settle();
      if (records.get("out:bench-file-1")?.state === "done" || now > end) break;
      waiters.sort((x, y) => x.at - y.at);
      const nextEvent = events[0]?.at ?? Infinity, nextWrite = waiters[0]?.at ?? Infinity;
      if (nextTick <= Math.min(nextEvent, nextWrite)) {
        now = nextTick;
        perSecond.push({ s: nextTick / 1000, bytes: confirmed - lastConfirmed, window: pace.window, limit: pace.limit(64 * 1024), base: pace.base, held: pace.held });
        lastConfirmed = confirmed;
        nextTick += 1_000;
        continue;
      }
      if (nextSay <= Math.min(nextEvent, nextWrite)) {
        now = nextSay;
        nextSay += 1_000;
        if (records.get("out:bench-file-1")?.state === "active") toB({ t: "text", said: now }, 200);
        continue;
      }
      if (nextWrite < nextEvent) { now = nextWrite; waiters.shift()!.resolve(); continue; }
      if (nextEvent === Infinity) throw new Error("nothing on the wire");
      const event = events.shift()!;
      now = event.at;
      if (event.frame.t === "text") { texts.push(now - (event.frame.said as number)); continue; }
      if (event.frame.t === "pf-accept" && started < 0) started = now;
      if (event.frame.t === "pf-sum") finished = now;
      if (event.frame.t === "pf-got" && event.to === "a") confirmed = Math.max(confirmed, event.frame.offset as number);
      await (event.to === "a" ? a : b).handle(event.frame);
    }
  } finally { a.detach(); b.detach(); }
  const seconds = ((finished > 0 ? finished : now) - started) / 1000;
  const sorted = texts.sort((x, y) => x - y), at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return { perSecond, seconds, confirmed, rate: confirmed / seconds, textP50: at(0.5), textP90: at(0.9) };
}

const MiB = 1024 * 1024;
const mbit = (n: number) => (n * 1_000_000) / 8 / 1000;
const kib = (n: number) => `${(n / 1024).toFixed(0)}K`;

/** The paths: a LAN, a relay far away, 5G with jitter, a relay over 5G, slow uplinks (where texts must stay quick). */
const PATHS: Path[] = [
  { name: "lan 1 Gbit/s 1 ms", size: 50 * MiB, upBytesPerMs: mbit(1000), delayMs: 0.5, jitterMs: 0.2 },
  { name: "relay 100 Mbit/s 150 ms", size: 30 * MiB, upBytesPerMs: mbit(100), delayMs: 75, jitterMs: 2 },
  { name: "5G 50 Mbit/s 30 ms jitter 40", size: 30 * MiB, upBytesPerMs: mbit(50), delayMs: 15, jitterMs: 40 },
  { name: "5G 50 Mbit/s 30 ms jitter 100", size: 30 * MiB, upBytesPerMs: mbit(50), delayMs: 15, jitterMs: 100 },
  { name: "relay over 5G 30 Mbit/s 300 ms jitter 100", size: 20 * MiB, upBytesPerMs: mbit(30), delayMs: 150, jitterMs: 100 },
  { name: "relay over 5G 30 Mbit/s 600 ms jitter 200", size: 20 * MiB, upBytesPerMs: mbit(30), delayMs: 300, jitterMs: 200 },
  { name: "lan + 2 ms writes", size: 30 * MiB, upBytesPerMs: mbit(1000), delayMs: 0.5, jitterMs: 0.2, writeMs: 2 },
  { name: "slow uplink 5 Mbit/s 40 ms", size: 8 * MiB, upBytesPerMs: mbit(5), delayMs: 20, jitterMs: 0 },
  { name: "slow uplink 1 Mbit/s 40 ms", size: 2 * MiB, upBytesPerMs: mbit(1), delayMs: 20, jitterMs: 0 },
  { name: "slow uplink 1 Mbit/s via relay 300 ms", size: 2 * MiB, upBytesPerMs: mbit(1), delayMs: 150, jitterMs: 0 },
  { name: "slow uplink 5 Mbit/s via relay 300 ms", size: 8 * MiB, upBytesPerMs: mbit(5), delayMs: 150, jitterMs: 0 },
  { name: "5G wander 100 ms / 200 ms", size: 30 * MiB, upBytesPerMs: mbit(50), delayMs: 15, jitterMs: 100, wanderMs: 200 },
  { name: "relay over 5G 600 ms wander 200 ms / 500 ms", size: 20 * MiB, upBytesPerMs: mbit(30), delayMs: 300, jitterMs: 200, wanderMs: 500 },
];

/** The runs whose second by second is printed: `GHOSTLY_FILES_BENCH_VERBOSE`, a pattern of `<mode>: <path>`. */
const VERBOSE = new RegExp(process.env.GHOSTLY_FILES_BENCH_VERBOSE ?? "^$");

/**
 * `FILE_LIMITS` as each run has them. "1 MiB, 50 ms" is the rule of 1.5.4: a queue of 50 ms on any path, 1 MiB of
 * one file in flight.
 */
const MODES: { name: string; knobs: Partial<Record<keyof typeof FILE_LIMITS, number>> }[] = [
  { name: "1 MiB, 50 ms", knobs: { queueOfBase: 0, trialGain: 1 } },
  // 1.6.0: by delay alone, no trials of a larger window.
  { name: "by delay", knobs: { trialGain: 1 } },
  { name: "now", knobs: {} },
  { name: "w1", knobs: { trialWindows: 1 } },
  { name: "w4", knobs: { trialWindows: 4 } },
  { name: "q50", knobs: { trialQueueMs: 50 } },
  { name: "g15", knobs: { trialGain: 1.5, trialPaid: 1.2 } },
  // One file with the chat's whole window: twice as fast on long fast paths here, nothing on WebRTC under netem.
  { name: "2 MiB a file", knobs: { windowBytes: 2 * 1024 * 1024 } },
];

// Minutes of transfers on a clock of their own take seconds; still not for every run of the suite.
// GHOSTLY_FILES_BENCH=1 npx vitest run --root packages/core test/chatFilesThroughput.bench.test.ts --silent=false
describe.skipIf(!process.env.GHOSTLY_FILES_BENCH)("file throughput between two peers (benchmark)", () => {
  const table: string[] = [];
  const kept = { ...FILE_LIMITS };
  afterEach(() => { Object.assign(FILE_LIMITS, kept); });
  afterAll(() => console.info(`mode path | MiB/s | link MiB/s | s | texts p50/p90 ms\n${table.join("\n")}`));
  for (const mode of MODES) for (const path of PATHS) {
    it(`${mode.name}: ${path.name}`, async () => {
      Object.assign(FILE_LIMITS, mode.knobs);
      const result = await run(path, mode.name);
      const lines = result.perSecond.filter((p) => p.s % 5 === 0 || p.s <= 3).map((p) => `${String(p.s).padStart(4)}s ${(p.bytes / MiB).toFixed(2).padStart(7)} MiB/s  window ${kib(p.window).padStart(6)} limit ${kib(p.limit).padStart(6)} base ${p.base === Infinity ? "-" : Math.round(p.base)} ms held ${kib(p.held)}`);
      if (VERBOSE.test(`${mode.name}: ${path.name}`)) console.info(`${mode.name}: ${path.name}: ${(result.rate / MiB).toFixed(2)} MiB/s over ${result.seconds.toFixed(1)} s (${(result.confirmed / MiB).toFixed(1)} MiB), texts p50 ${result.textP50} p90 ${result.textP90} ms\n${lines.join("\n")}`);
      table.push(`${mode.name} ${path.name} | ${(result.rate / MiB).toFixed(2)} | ${((path.upBytesPerMs * 1000) / MiB).toFixed(1)} | ${result.seconds.toFixed(1)} | ${result.textP50}/${result.textP90}`);
    }, 600_000);
  }
});
