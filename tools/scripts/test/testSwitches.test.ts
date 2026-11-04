import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// covers: chat.edit.wire, chat.reactions.wire, chat.paired.pair-timing, delivery.hold.expiry, profiles.peek

const ROOT = join(import.meta.dirname, "../../..");
const SOURCES = ["apps/web/src", "apps/ui/src", "apps/extension/src", "packages/browser/src"];

/**
 * Switches read some other way, each with why. Every other `ghostly-test-*` key is read through `testSwitch`, so a
 * release build ignores it: a leftover or pasted key changes nothing there.
 */
const READ_OTHERWISE: Record<string, string> = {
  "ghostly-test-providers": "read with testBuild() (paymentAdapters/providers/testing.ts)",
  "ghostly-test-identities": "read with testBuild() (proofs/testing.ts)",
  "ghostly-test-built-in-apps": "read only in the suite's build (VITE_APPS_TEST)",
  "ghostly-test-services": "read only with a plain-HTTP services host, which only the suite's build has",
  "ghostly-test-wallet-setup": "turns on in an automated browser what a person gets anyway, or off; specs against a deployed build set it",
  "ghostly-test-name-step": "turns on in an automated browser what a person gets anyway, or off; specs against a deployed build set it",
  "ghostly-test-no-ratchet": "read with testBuild() (engine/node.ts testNoRatchet)",
};

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "node_modules" ? [] : files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("a release build reads no ghostly-test-* switch from storage: each goes through testSwitch, or says why not", () => {
  const unguarded: string[] = [];
  const seen = new Set<string>();
  for (const file of SOURCES.flatMap(files)) {
    readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\/\*\*|\*)/.test(line)) return;
      for (const [, key] of line.matchAll(/["'`](ghostly-test-[a-z0-9-]+)["'`]/g)) {
        seen.add(key);
        if (!(key in READ_OTHERWISE) && !line.includes(`testSwitch("${key}")`)) unguarded.push(`${relative(ROOT, join(ROOT, file))}:${i + 1} ${key}`);
      }
    });
  }
  expect(unguarded).toEqual([]);
  for (const key of ["ghostly-test-hold-ttl", "ghostly-test-pace", "ghostly-test-iroh", "ghostly-test-reactions", "ghostly-test-no-edit", "ghostly-test-peek-ms"]) expect(seen, key).toContain(key);
  for (const key of Object.keys(READ_OTHERWISE)) expect(seen, `${key} is listed but no longer read`).toContain(key);
});
