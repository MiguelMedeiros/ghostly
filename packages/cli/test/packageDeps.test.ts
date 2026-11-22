import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/**
 * Every file the bundle loads by a relative path is in dist/ and in what `npm pack` sends: the chunks it imports and the
 * WebAssembly it reads with `new URL(…, import.meta.url)` (Iroh's included, which every runtime start loads).
 * (`.ts` workers are the browser's paths, which Node never takes.)
 */
it("ships every chunk and WebAssembly file the bundle loads", () => {
  const root = join(import.meta.dirname, "..");
  const dist = join(root, "dist");
  const files = ["ghostly.mjs", ...readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js")).map((f) => join("assets", f))];
  const loaded = new Set<string>();
  for (const file of files) {
    const code = readFileSync(join(dist, file), "utf8");
    const specs = [
      ...code.matchAll(/(?:^import [^;]*? from |^export [^;]*? from |\bimport\()"(\.{1,2}\/[^"]+)"/gm),
      ...code.matchAll(/new URL\("([^"]+\.(?:wasm|m?js))", import\.meta\.url\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) loaded.add(relative(root, join(dist, dirname(file), spec)));
  }
  expect(loaded).toContain("dist/assets/ghostly_iroh_web_bg.wasm");
  expect([...loaded].some((path) => /^dist\/assets\/ghostly_iroh_web-[\w-]+\.js$/.test(path))).toBe(true);
  expect([...loaded].filter((path) => !existsSync(join(root, path))).sort()).toEqual([]);
  const packed = new Set(npmPack(root).map((f) => f.path));
  expect([...loaded].filter((path) => !packed.has(path)).sort()).toEqual([]);
});

/**
 * The WebAssembly of a package npm installs with the CLI (Bark, BDK, Fedimint) is read from that package: a copy in
 * dist/ was the same 21 MB a second time in every install (1.13.1 shipped 58 MB). Only the bundled SDKs' stay beside.
 */
it("reads an installed package's WebAssembly from that package, not from a copy in dist/", async () => {
  const root = join(import.meta.dirname, "..");
  const assets = join(root, "dist", "assets");
  const files = readdirSync(assets);
  expect(files.filter((f) => f.endsWith(".wasm")).sort()).toEqual(["breez_sdk_spark_wasm_bg.wasm", "ghostly_iroh_web_bg.wasm"]);
  const installed = createRequire(join(root, "package.json"));
  for (const spec of ["@bitcoindevkit/bdk-wallet-web/bitcoindevkit_bg.wasm", "@fedimint/fedimint-client-wasm-bundler/fedimint_client_wasm_bg.wasm", "@secondts/bark/web/bark_ffi_wasm_bg.wasm"]) {
    const name = spec.slice(spec.lastIndexOf("/") + 1, -".wasm".length);
    const chunk = files.find((f) => f.startsWith(`${name}-`) && f.endsWith(".js"));
    expect(chunk, spec).toBeDefined();
    const { default: url } = await import(pathToFileURL(join(assets, chunk!)).href) as { default: string };
    expect(fileURLToPath(url)).toBe(installed.resolve(spec));
  }
});

/** What `npm pack` sends: npm 10 and 11 answer `[{files}]`, npm 12 `{"<name>": {files}}`. */
function npmPack(root: string): { path: string; mode: number }[] {
  const out = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as unknown;
  const [pack] = (Array.isArray(out) ? out : Object.values(out as object)) as { files: { path: string; mode: number }[] }[];
  return pack.files;
}

/** The README and SKILL.md send a reader to `examples/…`: the package holds them, for whoever installed it from npm. */
it("ships every example the README and SKILL.md name", () => {
  const root = join(import.meta.dirname, "..");
  const named = new Set<string>();
  for (const doc of ["README.md", "SKILL.md"]) for (const m of readFileSync(join(root, doc), "utf8").matchAll(/\bexamples\/[\w-]+\.(?:sh|mjs)\b/g)) named.add(m[0]);
  expect(named).toContain("examples/payment-bot.mjs");
  const packed = new Map(npmPack(root).map((f) => [f.path, f.mode]));
  expect([...named].filter((path) => !packed.has(path)).sort()).toEqual([]);
  // The shell examples run as `./examples/echo-bot.sh`, as in the repository.
  expect([...packed].filter(([path, mode]) => path.endsWith(".sh") && !(mode & 0o100)).map(([path]) => path)).toEqual([]);
});
