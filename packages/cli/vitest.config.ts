import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { maxWorkers } from "../../vitest.shared.ts";

// As in packages/browser: OpenPGP.js's lightweight build, which the identity providers import.
const openpgp = join(createRequire(import.meta.url).resolve("openpgp"), "../../lightweight/openpgp.mjs");

export default defineConfig({
  resolve: { alias: [{ find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  test: { maxWorkers, testTimeout: 30_000, globalSetup: ["test/support/build.ts"] },
});
