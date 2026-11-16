import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { holdChat, holdOf, resumeHolds } from "../src/holds";
import { home } from "./support/cli";

/**
 * A daemon's profile with one chat on its live link, as backupHoldRace.test.ts has it: its store is the chat's mode.
 * `released` gathers the `chat.released` events.
 */
function profile(name: string) {
  const dir = home(name);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  let links = [{ id: "chat-1", profile: "paired-chat/1", deliveryMode: "stream", runnableTransports: ["webrtc/1"] }];
  const setMode = (mode: string) => { links = links.map((l) => ({ ...l, deliveryMode: mode })); };
  const node = {
    getState: () => ({ links }),
    setChatTransport: async () => { setMode("dht"); },
    setDeliveryMode: async ({ mode }: { mode: string }) => { setMode(mode); },
  };
  const released: unknown[] = [];
  const hub = { onState: () => () => {}, emit: (type: string, _id: string, data: unknown) => { if (type === "chat.released") released.push(data); } };
  const ctx = { runtime: { paths, server: { node } }, hub, mode: "daemon" } as unknown as ApiContext;
  return { ctx, mode: () => links[0]?.deliveryMode, link: () => links[0] as never, released };
}

afterEach(() => { vi.useRealTimers(); });

// A laptop that sleeps through a hold's end: Node's timers run on a clock that stops in sleep (Linux, macOS), the wall
// clock does not. The hold's one timer still had its whole time to run at the wake, so `chat show` said no hold while
// the chat stayed on DHT only (texts short, files waiting) for as long again as the hold had left when the lid closed.
it("a hold whose time is up while the machine sleeps ends within a minute of the wake", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { ctx, mode, link, released } = profile("hold-after-sleep");
  const until = await holdChat(ctx, link(), 30);
  expect(mode()).toBe("dht");

  // Asleep 2 hours: the wall clock moves on, no timer runs.
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  expect(holdOf(ctx, "chat-1"), "the hold is no longer reported").toBeNull();

  // Awake a minute.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mode(), "the chat is back on its live link").toBe("stream");
  expect(released).toEqual([{ chat: "chat-1", reason: "expired" }]);
  expect(Date.now()).toBeGreaterThan(until);
});

// The same for a hold a daemon times again at its start (`resumeHolds`), and a hold that is not up yet stays.
it("a hold timed again at a start ends within a minute of a wake past its end, and not before its end", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { ctx, mode, link, released } = profile("hold-after-sleep-resumed");
  const until = await holdChat(ctx, link(), 120);
  resumeHolds(ctx);

  // Asleep 1 hour: an hour of the hold left.
  vi.setSystemTime(Date.now() + 60 * 60_000);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(mode(), "an hour of the hold is still to run").toBe("dht");
  expect(holdOf(ctx, "chat-1")).toBe(until);

  // Asleep 2 hours more: past its end.
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mode()).toBe("stream");
  expect(released).toEqual([{ chat: "chat-1", reason: "expired" }]);
});
