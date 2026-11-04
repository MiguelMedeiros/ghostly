import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { ghostlyPlatformModules, tauriAliases } from "../../packages/browser/vite-plugin.ts";
import { maxWorkers } from "../../tools/vitest.shared.ts";

/**
 * Component and hook tests for the shared UI (`apps/ui/src/`) and `@ghostly/react`. They render the UI as the web app
 * builds it: the platform modules are the browser peer's (`packages/browser/src/platform/`), and that peer is a
 * fake host the tests script (`apps/ui/src/test/fakeEngine.ts`), so no engine, network or storage is involved.
 * Stylesheets are left out: these tests check what the UI says and does, not how it looks.
 */
// As in packages/browser/vitest.config.ts: OpenPGP.js publishes its lightweight build under a "browser" condition
// only, and the identity providers (Profile → Identities) load it.
const openpgp = join(createRequire(import.meta.url).resolve("openpgp"), "../../lightweight/openpgp.mjs");

/**
 * Each language's folder as one module that reads its area files itself, with the keys its index.ts gives them. setup.ts
 * loads all 8 languages for every test file, and each area file as a module of its own, fetched from Vite, took about
 * 310 ms per test file; read here, about 30 ms.
 */
const localeFolder = /\/apps\/ui\/src\/locales\/([^/]+)\/index\.ts$/;
const localesAtOnce: Plugin = {
  name: "ghostly-test-locales-at-once",
  enforce: "pre",
  load(id) {
    const language = localeFolder.exec(id)?.[1];
    if (!language) return null;
    const key = language === "en" ? "name.slice(0, -5)" : "`./${name}`";
    return `import { readdirSync, readFileSync } from "node:fs";
const folder = ${JSON.stringify(dirname(id))};
const names = readdirSync(folder).filter((name) => name.endsWith(".json"));
export default Object.fromEntries(names.map((name) => [${key}, JSON.parse(readFileSync(folder + "/" + name, "utf8"))]));`;
  },
};

export default defineConfig({
  // Paths below are from the repository root: the UI's tests and @ghostly/react's.
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [localesAtOnce, ghostlyPlatformModules(), react()],
  resolve: { alias: [...Object.entries(tauriAliases ?? {}).map(([find, replacement]) => ({ find, replacement })), { find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  test: {
    name: "ui",
    environment: "happy-dom",
    include: ["apps/ui/src/**/*.test.{ts,tsx}", "packages/react/test/**/*.test.{ts,tsx}"],
    setupFiles: ["apps/ui/src/test/setup.ts"],
    css: false,
    restoreMocks: true,
    maxWorkers,
  },
});
