import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { precacheList } from "./src/sw/policy";

const SW_ENTRY = fileURLToPath(new URL("./src/sw/sw.ts", import.meta.url));

/**
 * `/sw.js`, the web app's service worker (`src/sw/sw.ts`). Built once the app's bundle is known, on its own:
 * a classic script with nothing to import, which every browser with service workers runs. It carries the
 * files to precache, read from the bundle and the public folder, and a version made of the build id and a
 * digest of those names: its cache is named after it, so a deploy is a new worker with a cache of its own.
 * The dev server has none: the app registers it in builds only.
 */
export function serviceWorker(buildId: string): Plugin {
  let publicFiles: string[] = [];
  return {
    name: "ghostly-service-worker",
    apply: "build",
    async buildStart() {
      const dir = fileURLToPath(new URL("./public", import.meta.url));
      publicFiles = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    async generateBundle(_options, bundle) {
      const precache = precacheList([...publicFiles, ...Object.keys(bundle)]);
      // The commit, and what was built from it: a rebuild of the same commit that changed a file is a new cache too.
      const version = `${buildId}-${createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 8)}`;
      const output = await build({
        configFile: false,
        logLevel: "warn",
        define: { __SW_BUILD__: JSON.stringify(version), __SW_PRECACHE__: JSON.stringify(precache) },
        build: {
          write: false,
          emptyOutDir: false,
          minify: true,
          lib: { entry: SW_ENTRY, formats: ["iife"], name: "ghostlyServiceWorker", fileName: () => "sw.js" },
        },
      });
      const chunk = (Array.isArray(output) ? output : [output]).flatMap((o) => ("output" in o ? o.output : [])).find((o) => o.type === "chunk");
      if (!chunk || chunk.type !== "chunk") throw new Error("The service worker did not build");
      this.emitFile({ type: "asset", fileName: "sw.js", source: chunk.code });
    },
  };
}
