import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, type Rollup } from "vite";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

/** The files a build of a page that loads the language detector writes, with translation in it or not. */
async function written(translate: boolean): Promise<string[]> {
  const dir = mkdtempSync(join(ROOT, "node_modules/.ghostly-translate-detector-worker-"));
  try {
    writeFileSync(join(dir, "entry.js"), `export { loadDetector } from "${ROOT}/apps/ui/src/lib/translateDetector.ts";\n`);
    const output = await build({
      root: dir, envDir: dir, configFile: false, logLevel: "silent",
      define: { "import.meta.env.VITE_TRANSLATE": JSON.stringify(translate ? "1" : "") },
      build: { write: false, minify: false, lib: { entry: join(dir, "entry.js"), formats: ["es"], fileName: "bundle" } },
    }) as Rollup.RollupOutput[];
    return output[0].output.map((file) => file.fileName);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The language detector's worker (2 MB) is Desktop's alone: a build without translation (the web, the extension)
 * writes no file of it, which no page of it would ever load.
 */
it("a build without translation writes no language detector worker, one with it does", async () => {
  expect((await written(false)).filter((name) => name.includes("translateDetector.worker"))).toEqual([]);
  expect((await written(true)).filter((name) => name.includes("translateDetector.worker"))).toHaveLength(1);
}, 120_000);
