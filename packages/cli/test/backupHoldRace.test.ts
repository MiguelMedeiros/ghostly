import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ApiContext } from "../src/apiKit";
import { BACKUP_METHODS, restoreProfile } from "../src/backup";
import { holdChat, releaseHold } from "../src/holds";
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
  };
  const node = {
    getState: () => ({ links }),
    setChatTransport: async () => { if (t.failSwitch) throw new Error("Delivery method unavailable."); setMode("dht"); await t.switched; },
    setDeliveryMode: async ({ mode }: { mode: string }) => { setMode(mode); },
  };
  const store = { async exportSnapshot(path: string) { await t.duringExport(); t.exported = links[0].deliveryMode; await writeFile(path, t.exported, { mode: 0o600 }); } };
  const hub = { onState: () => () => {}, emit: () => {} };
  const ctx = { runtime: { paths, store, server: { node } }, hub, mode: "daemon" } as unknown as ApiContext;
  const backup = async (out: string) => {
    await BACKUP_METHODS["profile.backup"](ctx, { path: join(dir, out), noPassphrase: true });
    const restored = await restoreProfile(home(`${name}-to`), "back", join(dir, out));
    return JSON.parse(readFileSync(join(restored.dir, "holds.json"), "utf8")) as Record<string, { until: number }>;
  };
  return { t, ctx, paths, link: () => links[0] as never, backup };
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
