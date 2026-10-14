import { describe, expect, it } from "vitest";
import { ChatFiles, FILE_LIMITS, type ChatFilesHost, type FileTransferRecord } from "../src/chatFiles";
import type { FileInfo } from "../src/files";
// covers: files.large.limits

/**
 * A file sent over a link with a bottleneck, on a clock of its own: the sender's frames leave one after another at
 * `upBytesPerMs` (a queue with no end, as netem's), and each way takes `delayMs`. Every `sayEveryMs` the sender says
 * something else in the chat (a text, a ring) on the same channel; how long that takes to arrive is what is measured.
 */
async function slowUplink(options: { size: number; upBytesPerMs: number; delayMs: number; sayEveryMs: number }) {
  let now = 0, upFree = 0;
  const events: { at: number; to: "a" | "b"; frame: Record<string, unknown>; said?: number }[] = [];
  const schedule = (event: (typeof events)[number]) => {
    let i = events.length;
    while (i && events[i - 1].at > event.at) i--;
    events.splice(i, 0, event);
  };
  const uplink = (frame: Record<string, unknown>, bytes: number, said?: number) => {
    upFree = Math.max(now, upFree) + bytes / options.upBytesPerMs;
    schedule({ at: upFree + options.delayMs, to: "b", frame, said });
  };
  const records = new Map<string, FileTransferRecord>();
  const host = (name: "a" | "b"): ChatFilesHost => ({
    send: (frame) => {
      if (name === "a") uplink(JSON.parse(JSON.stringify(frame)) as Record<string, unknown>, JSON.stringify(frame).length);
      else schedule({ at: now + options.delayMs, to: "a", frame: JSON.parse(JSON.stringify(frame)) as Record<string, unknown> });
      return true;
    },
    sendData: (id, offset, data) => { uplink({ t: "pf-data", id, offset, data: Buffer.from(data).toString("base64url") }, data.length + 32); return true; },
    decide: async () => "accept",
    openTarget: async () => ({ offset: 0, append: async () => {}, flush: async () => {}, verify: async () => true, discard: async () => {} }),
    openSource: async () => ({ read: async (offset, length) => new Uint8Array(Math.min(length, options.size - offset)), digest: async () => "A".repeat(43) }),
    changed: (record) => { records.set(`${record.direction}:${record.id}`, record); },
    now: () => now,
  });
  const a = new ChatFiles(host("a")), b = new ChatFiles(host("b"));
  a.attach(); b.attach();
  const info: FileInfo = { id: "slow-up-1", name: "big.bin", mime: "application/octet-stream", size: options.size, timestamp: 1 };
  a.offer(info);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const latencies: { at: number; ms: number }[] = [];
  let nextSay = options.sayEveryMs, started = -1, finished = -1;
  try {
    for (;;) {
      await settle();
      if (records.get("out:slow-up-1")?.state === "done") break;
      if (!events.length) throw new Error("nothing on the wire");
      if (nextSay <= events[0].at) {
        now = nextSay;
        nextSay += options.sayEveryMs;
        if (records.get("out:slow-up-1")?.state === "active") uplink({ t: "text" }, 200, now);
        continue;
      }
      const event = events.shift()!;
      now = event.at;
      if (event.frame.t === "text") { latencies.push({ at: event.said!, ms: now - event.said! }); continue; }
      if (event.frame.t === "pf-accept" && started < 0) started = now;
      if (event.frame.t === "pf-sum") finished = now;
      await (event.to === "a" ? a : b).handle(event.frame);
    }
  } finally { a.detach(); b.detach(); }
  return { latencies, seconds: (finished - started) / 1000 };
}

describe("a file sent over a slow uplink", () => {
  it("leaves room for what else its sender says in the chat, and still takes the bandwidth", async () => {
    // 5 Mbit/s up, 20 ms each way. With a fixed 1 MiB in flight, every text, ring or hang-up from the sender queued
    // behind it: 1.8 s each, for as long as the upload went.
    const size = 8 * 1024 * 1024, upBytesPerMs = 5_000_000 / 8 / 1000;
    const { latencies, seconds } = await slowUplink({ size, upBytesPerMs, delayMs: 20, sayEveryMs: 1_000 });
    expect(latencies.length).toBeGreaterThan(8);
    const worst = Math.max(...latencies.filter((l) => l.at > 2_000).map((l) => l.ms));
    expect(worst, `texts took up to ${Math.round(worst)} ms`).toBeLessThan(250);
    // The link stays full: the file takes about as long as the link needs for it.
    expect(seconds).toBeLessThan((size / upBytesPerMs / 1000) * 1.1);
  }, 60_000);

  it("keeps a full window on a fast link with a long round trip", async () => {
    // 1 Gbit/s, 50 ms each way: 1 MiB per round trip is about 10 MiB/s, and a small fixed window would cut it to a tenth.
    const size = 40 * 1024 * 1024;
    const { seconds } = await slowUplink({ size, upBytesPerMs: 125_000, delayMs: 50, sayEveryMs: 60_000 });
    const perRoundTrip = FILE_LIMITS.windowBytes / 0.1;
    expect(size / seconds, `${(size / seconds / 2 ** 20).toFixed(1)} MiB/s`).toBeGreaterThan(perRoundTrip * 0.8);
  }, 60_000);
});
