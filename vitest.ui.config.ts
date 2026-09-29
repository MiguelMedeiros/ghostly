import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { ghostlyPlatformModules, tauriAliases } from "./packages/browser/vite-plugin.ts";
import { maxWorkers } from "./vitest.shared.ts";

/**
 * Component and hook tests for the shared UI (`src/`) and `@ghostly/react`. They render the UI as the web app
 * builds it: the platform modules are the browser peer's (`packages/browser/src/platform/`), and that peer is a
 * fake host the tests script (`src/test/fakeEngine.ts`), so no engine, network or storage is involved.
 * Stylesheets are left out: these tests check what the UI says and does, not how it looks.
 */
// As in packages/browser/vitest.config.ts: OpenPGP.js publishes its lightweight build under a "browser" condition
// only, and the identity providers (Profile → Identities) load it.
const openpgp = join(createRequire(import.meta.url).resolve("openpgp"), "../../lightweight/openpgp.mjs");

export default defineConfig({
  plugins: [ghostlyPlatformModules(), react()],
  resolve: { alias: [...Object.entries(tauriAliases ?? {}).map(([find, replacement]) => ({ find, replacement })), { find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  test: {
    name: "ui",
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}", "packages/react/test/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    css: false,
    restoreMocks: true,
    maxWorkers,
  },
});
