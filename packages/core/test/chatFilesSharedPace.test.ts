import { describe, expect, it } from "vitest";
import { ChatFiles, FileUplink, type ChatFilesHost, type FileTransferRecord } from "../src/chatFiles";
import type { FileInfo } from "../src/files";
// covers: files.large.limits

/**
 * One device serving a file to `askers` members at once, each over a session of its own (a group's edges), all
 * leaving by one uplink of `upBytesPerMs` (a queue with no end, as tc's) and `delayMs` each way. Every `sayEveryMs`
 * the device says something else (a text to the group, a ring) on that uplink; how long it takes to arrive is what is
 * measured. `shared`: the edges' files share one `FileUplink`, as the engine's group edges do.
 */
async function serving(options: { askers: number; size: number; upBytesPerMs: number; delayMs: number; sayEveryMs: number; shared: boolean }) {
  let now = 0, upFree = 0;
  const events: { at: number; to: string; frame: Record<string, unknown>; said?: number }[] = [];
  const schedule = (event: (typeof events)[number]) => {
    let i = events.length;
    while (i && events[i - 1].at > event.at) i--;
    events.splice(i, 0, event);
  };
  const uplink = (to: string, frame: Record<string, unknown>, bytes: number, said?: number) => {
    upFree = Math.max(now, upFree) + bytes / options.upBytesPerMs;
    schedule({ at: upFree + options.delayMs, to, frame, said });
  };
  const records = new Map<string, FileTransferRecord>();
  const shared = options.shared ? new FileUplink() : undefined;
  const host = (name: string, peer: string, sender: boolean): ChatFilesHost => ({
    send: (frame) => {
      const copy = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
      if (sender) uplink(peer, copy, JSON.stringify(frame).length);
      else schedule({ at: now + options.delayMs, to: peer, frame: copy });
      return true;
    },
    sendData: (id, offset, data) => { uplink(peer, { t: "pf-data", id, offset, data: Buffer.from(data).toString("base64url") }, data.length + 32); return true; },
    decide: async () => "accept",
    openTarget: async () => ({ offset: 0, append: async () => {}, flush: async () => {}, verify: async () => true, discard: async () => {} }),
    openSource: async () => ({ read: async (offset, length) => new Uint8Array(Math.min(length, options.size - offset)), digest: async () => "A".repeat(43) }),
    changed: (record) => { records.set(`${name}:${record.direction}:${record.id}`, record); },
    now: () => now,
    ...(sender && shared ? { uplink: shared } : {}),
  });
  const sides = new Map<string, ChatFiles>();
  for (let i = 0; i < options.askers; i++) {
    sides.set(`a${i}`, new ChatFiles(host(`a${i}`, `b${i}`, true)));
    sides.set(`b${i}`, new ChatFiles(host(`b${i}`, `a${i}`, false)));
  }
  for (const side of sides.values()) side.attach();
  const info: FileInfo = { id: "photo-file-1", name: "photo.jpg", mime: "image/jpeg", size: options.size, timestamp: 1 };
  for (let i = 0; i < options.askers; i++) sides.get(`a${i}`)!.offer(info);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const done = () => [...Array(options.askers).keys()].every((i) => records.get(`a${i}:out:photo-file-1`)?.state === "done");
  const active = () => [...Array(options.askers).keys()].some((i) => records.get(`a${i}:out:photo-file-1`)?.state === "active");
  const latencies: number[] = [];
  let nextSay = options.sayEveryMs;
  try {
    for (;;) {
      await settle();
      if (done()) break;
      if (!events.length) throw new Error("nothing on the wire");
      if (nextSay <= events[0].at) {
        now = nextSay;
        nextSay += options.sayEveryMs;
        if (active()) uplink("text", { t: "text" }, 200, now);
        continue;
      }
      const event = events.shift()!;
      now = event.at;
      if (event.frame.t === "text") { latencies.push(now - event.said!); continue; }
      await sides.get(event.to)!.handle(event.frame);
    }
  } finally { for (const side of sides.values()) side.detach(); }
  latencies.sort((x, y) => x - y);
  return { p50: latencies[Math.floor(latencies.length / 2)]!, p90: latencies[Math.floor(latencies.length * 0.9)]!, seconds: now / 1000 };
}

// agents#1569: on 5 CLI daemons with alice's uplink at 1 Mbit/s, alice serving a 2 MiB picture to 3 members held her
// texts 1-2 s behind the files (p50 939-2097 ms, max 5.8 s): each edge kept its own 64 KiB floor, 192 KiB in all.
describe("a device serving a group file to several members at once over a slow uplink", () => {
  it("keeps what else it says near the delay target, as one file to one member does", async () => {
    const lab = { askers: 3, size: 2 * 1024 * 1024, upBytesPerMs: 125, delayMs: 5, sayEveryMs: 500 };
    const alone = await serving({ ...lab, shared: false });
    const shared = await serving({ ...lab, shared: true });
    const one = await serving({ ...lab, askers: 1, shared: true });
    console.info(`texts behind 3 transfers at 1 Mbit/s: paced per edge p50 ${Math.round(alone.p50)} p90 ${Math.round(alone.p90)} ms (${alone.seconds.toFixed(1)} s); shared p50 ${Math.round(shared.p50)} p90 ${Math.round(shared.p90)} ms (${shared.seconds.toFixed(1)} s); one transfer p50 ${Math.round(one.p50)} ms`);
    expect(alone.p50, "paced per edge, the files queue three floors' worth").toBeGreaterThan(1_000);
    expect(shared.p50).toBeLessThan(700);
    expect(shared.p90).toBeLessThan(900);
    // The uplink stays full: three files take about three times as long as one, not more.
    expect(shared.seconds).toBeLessThan(alone.seconds * 1.2);
  }, 60_000);
});
