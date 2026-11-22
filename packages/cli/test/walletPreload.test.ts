import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { preloadWalletModules } from "../src/runtime/engine";
// covers: headless.wallets

// The runtime loads Arkade's descriptor library whole before any wallet starts. The CLI declared that library itself,
// and once Dependabot moved its range past the version Arkade pins, the preload loaded a second copy and never the
// one Arkade runs.
it("preloads the descriptor library Arkade runs, and no other copy of it", async () => {
  await preloadWalletModules();
  const require = createRequire(import.meta.url);
  const arkades = createRequire(require.resolve("@arkade-os/sdk")).resolve("@bitcoinerlab/descriptors-scure");
  const loaded = Object.keys(require.cache).filter((file) => /[/\\]@bitcoinerlab[/\\]descriptors-scure[/\\]dist[/\\]index\.js$/.test(file));
  expect(loaded).toEqual([arkades]);
});
