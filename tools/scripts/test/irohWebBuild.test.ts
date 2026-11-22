import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { irohWebFileHash, irohWebSourceHash } from "../iroh-web-source.mjs";
// covers: transport.iroh-web

/**
 * packages/iroh-web/pkg is committed, built by tools/scripts/build-iroh-web.mjs. wasm-bindgen's output is not
 * reproducible byte for byte, so CI does not rebuild it; it checks that it was built from the crate as it is,
 * against the iroh the Desktop runs, and not edited since.
 */
const root = join(import.meta.dirname, "../../..");
const build = JSON.parse(readFileSync(join(root, "packages/iroh-web/pkg/BUILD.json"), "utf8"));

it("was built from the crate's current sources (run node tools/scripts/build-iroh-web.mjs after changing it)", () => {
  expect(build.source).toBe(irohWebSourceHash(root));
});

it("runs the iroh the Desktop runs, so both speak the same QUIC and TLS", () => {
  const desktop = /iroh = "=([\d.]+)"/.exec(readFileSync(join(root, "native/transports/Cargo.toml"), "utf8"))?.[1];
  expect(build.iroh).toBe(desktop);
});

it("ships the wasm that build produced", () => {
  const wasm = readFileSync(join(root, "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm"));
  expect(createHash("sha256").update(wasm).digest("hex")).toBe(build.sha256);
});

it("ships the JavaScript and types that build produced beside it", () => {
  // The JavaScript runs in the page that loads the wasm: a hand edit there must fail as one to the wasm does.
  const glue = readdirSync(join(root, "packages/iroh-web/pkg")).filter((name) => name !== "BUILD.json" && name !== "ghostly_iroh_web_bg.wasm");
  expect(glue.length).toBeGreaterThan(0);
  expect(Object.keys(build.files ?? {}).sort()).toEqual(glue.sort());
  for (const name of glue) expect(irohWebFileHash(join(root, "packages/iroh-web/pkg", name)), name).toBe(build.files?.[name]);
});
