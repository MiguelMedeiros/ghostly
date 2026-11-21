import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { forgetHold, holdChat, releaseHold, resumeHolds } from "../src/holds";
import { home } from "./support/cli";

/**
 * A daemon's profile with one chat on its live link. Its store is the chat's mode (`setChatTransport` and
 * `setDeliveryMode` write it at once, as the engine patches the link before it switches it); `switched` holds the
 * switch's end back, as a slow live link does. `duringExport` runs while the backup takes the store.
 */
function profile(name: string) {
  const dir = home(name);
  const paths = { dir, db: join(dir, "db"), files: join(dir, "files") };
  mkdirSync(paths.db, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  let links = [{ id: "chat-1", profile: "paired-chat/1", deliveryMode: "stream", runnableTransports: ["webrtc/1"] }];
  const setMode = (mode: string) => { links = links.map((l) => ({ ...l, deliveryMode: mode })); };
  const t = {
    switched: Promise.resolve() as Promise<void>,
    failSwitch: false,
    duringExport: async () => {},
    exported: "",
    restored: "",
  };
  const node = {
    getState: () => ({ links }),
    setChatTransport: async () => { if (t.failSwitch) throw new Error("Delivery method unavailable."); setMode("dht"); await t.switched; },
    setDeliveryMode: async ({ mode }: { mode: string }) => { setMode(mode); },
  };
  const store = { async exportSnapshot(path: string) { await t.duringExport(); t.exported = links[0]?.deliveryMode ?? ""; await writeFile(path, t.exported, { mode: 0o600 }); } };
  const hub = { onState: () => () => {}, emit: () => {} };
  const ctx = { runtime: { paths, store, server: { node } }, hub, mode: "daemon" } as unknown as ApiContext;
  const backup = async (out: string) => {
    await BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, out), noPassphrase: true });
    const restored = await restoreProfile(home(`${name}-to`), "back", join(dir, out));
    t.restored = restored.dir;
    return JSON.parse(readFileSync(join(restored.dir, "holds.json"), "utf8")) as Record<string, { until: number }>;
  };
  const remove = (linkId: string) => { links = links.filter((l) => l.id !== linkId); };
  return { t, ctx, paths, link: () => links[0] as never, remove, backup };
}

// `chat disconnect --hold` while a backup runs: the backup read holds.json before the store, the hold was written after
// the chat went on DHT only, and the store was taken in between. The restored chat stayed on DHT only for good.
it("a hold that starts while a backup takes the store is in the backup", async () => {
  const { t, ctx, link, backup } = profile("backup-hold-starts");
  let until = 0;
  t.duringExport = async () => { until = await holdChat(ctx, link(), 30); };
  const holds = await backup("starts.ghostly-backup");
  expect(t.exported, "the store has the chat on DHT only").toBe("dht");
  expect(holds).toEqual({ "chat-1": expect.objectContaining({ until }) });
  await releaseHold(ctx, "chat-1", "lifted");
});

// The engine names the chat DHT only in its store before the switch ends (the live link stops after): a store taken
// then has it on DHT only while `chat disconnect --hold` still waits for the switch.
it("a hold whose switch to DHT only is still running when the store is taken is in the backup", async () => {
  const { t, ctx, link, backup } = profile("backup-hold-switching");
  let done!: () => void;
  t.switched = new Promise((resolve) => { done = resolve; });
  let held: Promise<number> | undefined;
  t.duringExport = async () => { held = holdChat(ctx, link(), 30); await new Promise((resolve) => setImmediate(resolve)); };
  const holds = await backup("switching.ghostly-backup");
  done();
  const until = await held!;
  expect(t.exported, "the store has the chat on DHT only").toBe("dht");
  expect(holds).toEqual({ "chat-1": expect.objectContaining({ until }) });
  await releaseHold(ctx, "chat-1", "lifted");
});

// The other way (as before): a hold that ends while the store is taken stays in the backup, its chat back on its live
// link there, and the restored daemon ends it.
it("a hold that ends while a backup takes the store stays in the backup", async () => {
  const { t, ctx, paths, link, backup } = profile("backup-hold-ends");
  const until = await holdChat(ctx, link(), 30);
  t.duringExport = async () => { await releaseHold(ctx, "chat-1", "expired"); };
  const holds = await backup("ends.ghostly-backup");
  expect(t.exported).toBe("stream");
  expect(holds).toEqual({ "chat-1": expect.objectContaining({ until }) });
  expect(JSON.parse(readFileSync(join(paths.dir, "holds.json"), "utf8"))).toEqual({});
});

it("a hold whose switch to DHT only fails leaves no hold, and keeps the others", async () => {
  const { t, ctx, paths, link } = profile("backup-hold-fails");
  const other = { until: Date.now() + 60_000, since: Date.now() };
  writeFileSync(join(paths.dir, "holds.json"), JSON.stringify({ "chat-2": other }) + "\n");
  t.failSwitch = true;
  await expect(holdChat(ctx, link(), 30)).rejects.toMatchObject({ code: "unavailable" });
  expect(JSON.parse(readFileSync(join(paths.dir, "holds.json"), "utf8"))).toEqual({ "chat-2": other });
});

/** A daemon's start over `dir` (`resumeHolds`) whose store has these chats, on DHT only. */
function start(dir: string, chats: string[]) {
  let links = chats.map((id) => ({ id, profile: "paired-chat/1", deliveryMode: "dht", runnableTransports: ["webrtc/1"] }));
  const emitted: Record<string, unknown>[] = [];
  const node = {
    getState: () => ({ links }),
    setDeliveryMode: vi.fn(async ({ linkId, mode }: { linkId: string; mode: string }) => { links = links.map((l) => (l.id === linkId ? { ...l, deliveryMode: mode } : l)); }),
  };
  const hub = { onState: () => () => {}, emit: (type: string, _id: string, fields: Record<string, unknown>) => { emitted.push({ type, ...fields }); } };
  const ctx = { runtime: { server: { node }, paths: { dir } }, hub, mode: "daemon" } as unknown as ApiContext;
  const holds = () => JSON.parse(readFileSync(join(dir, "holds.json"), "utf8")) as Record<string, { until: number }>;
  return { ctx, node, emitted, holds };
}

// `chat remove` while a backup runs: the chat is gone from the store, but the backup's first read of holds.json still had
// its hold. The restored daemon timed it, and its end said chat.released for a chat it does not have.
it("a chat removed while a backup takes the store: the restored profile drops its hold and never says it ended", async () => {
  const { t, ctx, link, remove, backup } = profile("backup-hold-removed");
  await holdChat(ctx, link(), 30);
  t.duringExport = async () => { remove("chat-1"); await forgetHold(ctx, "chat-1"); };
  const backedUp = await backup("removed.ghostly-backup");
  expect(t.exported, "the store has no chat").toBe("");
  // The backup itself may carry the hold (it cannot tell which chats its store has): the restored start drops it.
  expect(Object.keys(backedUp)).toEqual(["chat-1"]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const restored = start(t.restored, []);
    resumeHolds(restored.ctx);
    expect(restored.holds(), "holds.json no longer names the removed chat").toEqual({});
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(restored.emitted).toEqual([]);
    expect(restored.node.setDeliveryMode).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

// The same for any hold whose chat the store does not have (an older backup, a hand-edited holds.json): dropped at the
// start with nothing said, and the folder's file without it; the other holds run on.
it("a daemon's start drops a hold whose chat is not in its store, with no release said", async () => {
  const dir = home("resume-holds-gone");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(join(dir, "holds.json"), JSON.stringify({ "chat-gone": { until: now - 1, since: now - 60_000 }, "chat-kept": { until: now + 60_000, since: now } }) + "\n");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const { ctx, node, emitted, holds } = start(dir, ["chat-kept"]);
    resumeHolds(ctx);
    expect(holds()).toEqual({ "chat-kept": { until: now + 60_000, since: now } });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitted).toEqual([{ type: "chat.released", chat: "chat-kept", reason: "expired" }]);
    expect(node.setDeliveryMode).toHaveBeenCalledTimes(1);
    expect(node.setDeliveryMode).toHaveBeenCalledWith({ linkId: "chat-kept", mode: "stream" });
    expect(holds()).toEqual({});
  } finally { vi.useRealTimers(); }
});
