import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeRuntimeFiles } from "../native-runtime-files.mjs";
// covers: transport.hyperdht

/**
 * The Desktop ships native/transports/hyperdht as a flat folder (tools/scripts/prepare-native-runtime.mjs). Its file
 * list was fixed, so redial.mjs, which endpoint.mjs imports, was left out: the sidecar could not start and the
 * Desktop had no HyperDHT (CI run 37617727662, bug hunt r11h).
 */
const source = join(import.meta.dirname, "../../../native/transports/hyperdht");

it("ships every module the sidecar imports, redial.mjs included", () => {
  expect(nativeRuntimeFiles(source)).toEqual(["package.json", "package-lock.json", "endpoint.mjs", "redial.mjs", "sidecar.mjs"]);
});

it("follows each kind of relative import, and refuses a module outside the flat folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-runtime-"));
  writeFileSync(join(dir, "sidecar.mjs"), "import { a } from './a.mjs'\nimport './b.mjs'\nimport DHT from 'hyperdht'\nconst c = await import('./c.mjs')\n");
  writeFileSync(join(dir, "a.mjs"), "export { d } from './d.mjs'\nimport { a } from './a.mjs'\n");
  for (const name of ["b.mjs", "c.mjs", "d.mjs"]) writeFileSync(join(dir, name), "export const x = 1\n");
  expect(nativeRuntimeFiles(dir)).toEqual(["package.json", "package-lock.json", "a.mjs", "b.mjs", "c.mjs", "d.mjs", "sidecar.mjs"]);
  writeFileSync(join(dir, "d.mjs"), "import { e } from './lib/e.mjs'\n");
  expect(() => nativeRuntimeFiles(dir)).toThrow(/copied flat/);
});
