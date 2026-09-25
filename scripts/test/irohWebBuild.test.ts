import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { irohWebSourceHash } from "../iroh-web-source.mjs";
// covers: transport.iroh-web

/**
 * packages/iroh-web/pkg is committed, built by scripts/build-iroh-web.mjs. wasm-bindgen's output is not
 * reproducible byte for byte, so CI does not rebuild it; it checks that it was built from the crate as it is,
 * against the iroh the Desktop runs, and not edited since.
 */
const root = join(import.meta.dirname, "../..");
const build = JSON.parse(readFileSync(join(root, "packages/iroh-web/pkg/BUILD.json"), "utf8"));

it("was built from the crate's current sources (run node scripts/build-iroh-web.mjs after changing it)", () => {
  expect(build.source).toBe(irohWebSourceHash(root));
});

it("runs the iroh the Desktop runs, so both speak the same QUIC and TLS", () => {
  const desktop = /iroh = "=([\d.]+)"/.exec(readFileSync(join(root, "native-transports/Cargo.toml"), "utf8"))?.[1];
  expect(build.iroh).toBe(desktop);
});

it("ships the wasm that build produced", () => {
  const wasm = readFileSync(join(root, "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm"));
  expect(createHash("sha256").update(wasm).digest("hex")).toBe(build.sha256);
});
