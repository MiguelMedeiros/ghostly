import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { maxWorkers, quarantined } from "../../tools/vitest.shared.ts";
import { TimedShards } from "../../tools/vitest.shards.ts";

// As in packages/browser: OpenPGP.js's lightweight build, which the identity providers import.
const openpgp = join(createRequire(import.meta.url).resolve("openpgp"), "../../lightweight/openpgp.mjs");

export default defineConfig({
  resolve: { alias: [{ find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  // `--shard` by time (CI's draft tier runs the CLI in two halves); without --shard, Vitest's own order.
  test: { maxWorkers, exclude: quarantined(), testTimeout: 30_000, globalSetup: ["test/support/build.ts"], sequence: { sequencer: TimedShards } },
});
