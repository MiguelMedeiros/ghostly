import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

/**
 * The binary tests run the CLI as users do: built once, before them. The run gets its own temp folder (TMPDIR, which
 * the workers and every `ghostly` they start inherit), removed at its end: the profile homes tests make were left in
 * /tmp, hundreds of MB a run. A short name: a profile's socket stays in its folder only up to 100 bytes of path.
 */
export default async function setup(): Promise<() => void> {
  const root = resolve(import.meta.dirname, "../..");
  await build({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "warn" });
  const run = mkdtempSync(join(tmpdir(), "cli-"));
  process.env.TMPDIR = run;
  return () => rmSync(run, { recursive: true, force: true });
}
