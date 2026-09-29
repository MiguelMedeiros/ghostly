import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// covers: headless.package

/** Every package the built CLI imports is one its package.json installs: the bundle runs where npm put it. */
it("declares every npm package the bundle imports", () => {
  const dist = join(import.meta.dirname, "../dist");
  const files = ["ghostly.mjs", ...readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js")).map((f) => join("assets", f))];
  const imported = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(join(dist, file), "utf8").matchAll(/(?:^import [^;]*? from |\bimport\()"([^".][^"]*)"/gm)) {
      const spec = match[1];
      if (spec.startsWith("node:") || spec === "unknown") continue;
      imported.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect([...imported].filter((name) => !manifest.dependencies[name]).sort()).toEqual([]);
  expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith("@ghostly/"))).toEqual([]);
  expect(readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".wasm")).sort()).toEqual(expect.arrayContaining(["breez_sdk_spark_wasm_bg.wasm", "ghostly_iroh_web_bg.wasm"]));
});
