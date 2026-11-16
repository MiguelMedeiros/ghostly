import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import { serve, type Host } from "../src/host";
import { lockPath } from "../src/profiles";
// covers: headless.backup, headless.daemon

const root = mkdtempSync(join(tmpdir(), "gh-backup-gone-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/*
 * Ctrl-C on `profile backup` sent through a daemon closes the command's connection and says it stopped. The daemon went
 * on and wrote the whole backup where the person was told none was made: with --no-passphrase, a readable copy of the
 * profile.
 */
describe.skipIf(process.platform === "win32")("a backup whose client went away", () => {
  it("is not written: the daemon stops it, and leaves neither the backup, its partial file nor the store's copy", async () => {
    const dir = join(root, "p");
    const paths = { dir, db: join(dir, "db"), files: join(dir, "files"), socket: join(dir, "daemon.sock") };
    mkdirSync(paths.db, { recursive: true, mode: 0o700 });
    mkdirSync(paths.files, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath(dir), String(process.pid));
    for (let i = 0; i < 4; i++) writeFileSync(join(paths.files, `f${i}`), `FILE ${i}`);
    const outDir = join(root, "out");
    mkdirSync(outDir);
    // The store's export held until the client is gone: the backup is under way when Ctrl-C ends the command.
    let exported = false, release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const store = { async exportSnapshot(path: string) { writeFileSync(path, "STORE", { mode: 0o600 }); exported = true; await held; } };
    const ctx = { runtime: { paths, store }, hub: { onEvent: () => () => {} }, mode: "daemon" };
    const served = await serve({ ctx } as unknown as Host);
    try {
      const client = (await connectDaemon(paths))!;
      void client.call("profile.backup", { path: join(outDir, "b.ghostly-backup"), noPassphrase: true }).catch(() => {});
      await expect.poll(() => exported).toBe(true);
      client.destroy();
      const connections = () => new Promise<number>((resolve) => served.server.getConnections((_error, count) => resolve(count)));
      await expect.poll(connections).toBe(0);
      release();
      // The backup's own cleanup has run once the store's copy is gone.
      await expect.poll(() => readdirSync(paths.db)).toEqual([]);
      // Before: b.ghostly-backup, complete, though the command had said it stopped before it answered.
      expect(readdirSync(outDir)).toEqual([]);
    } finally { await served.close(); }
  });
});
