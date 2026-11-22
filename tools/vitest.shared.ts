import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";

/**
 * Settings every Vitest config here shares.
 *
 * Locally, several sessions test on one machine at once, and Vitest's default (a worker per core) in each of them
 * starved the machine: at most JOBS workers (default 2) when CI is unset. CI keeps Vitest's default.
 * `vitest --maxWorkers=<n>` still wins over this.
 */
export const maxWorkers = process.env.CI ? undefined : Math.max(1, Number(process.env.JOBS) || 2);

/** A list of tools/scripts/ (`{ file }` entries, paths from the repository root) as paths from `root`, those under it. */
function listed(name: string, root: string): string[] {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const list: { file: string }[] = JSON.parse(readFileSync(new URL(`./scripts/${name}`, import.meta.url), "utf8"));
  return list.map(({ file }) => relative(root, join(repo, file)).replaceAll("\\", "/")).filter((file) => !file.startsWith(".."));
}

/**
 * `base` (Vitest's own excludes by default) and the unit test files tools/scripts/quarantine.json takes out of the gate
 * for at most 7 days (docs/TESTING.md, "Quarantine"), as paths from the project's root: the folder Vitest runs in, or
 * the config's `root`. The nightly sets GHOSTLY_QUARANTINE=1 and keeps them. With GHOSTLY_INTEGRATION=0 (CI's
 * package shards, `test:affected`) also the files tools/scripts/integration-tests.json names, which start real peers,
 * daemons or a DHT: CI's Integration tests job runs them (test-shards.mjs --integration). A plain `npm test` keeps them.
 */
export function quarantined(base: string[] = configDefaults.exclude, root = process.cwd()): string[] {
  return [
    ...base,
    ...(process.env.GHOSTLY_QUARANTINE === "1" ? [] : listed("quarantine.json", root)),
    ...(process.env.GHOSTLY_INTEGRATION === "0" ? listed("integration-tests.json", root) : []),
  ];
}
