import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, type Plugin, type Rolldown } from "vite";
import { ghostlyPlatformModules } from "../vite-plugin";
// covers: proofs.pubky

/**
 * `@synonymdev/pubky`'s browser entry inlines its 2.5 MB wasm as base64: the Pubky proofs' chunk was 3.4 MB (1.1 MB
 * gzip), 0.34 MB gzip more than the wasm file the package ships beside it. The app's builds swap the inline copy for
 * that file, fetched on first use (`loadPubky`).
 */
const require = createRequire(import.meta.url);
const pubkyDir = dirname(require.resolve("@synonymdev/pubky/package.json"));
const wasm = readFileSync(join(pubkyDir, "pubky_bg.wasm"));

const ENTRY = "\0pubky-entry";
const entry = (names: string): Plugin => ({
  name: "pubky-entry",
  resolveId: (source) => (source === ENTRY ? ENTRY : null),
  load: (id) => (id === ENTRY ? `export { ${names} } from "@synonymdev/pubky";` : null),
});

async function buildPubky(names = "Keypair, pubkyWasmReady") {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: dirname(import.meta.dirname),
    plugins: [ghostlyPlatformModules(), entry(names)],
    build: { write: false, minify: false, rollupOptions: { input: ENTRY, preserveEntrySignatures: "strict" } },
  });
  const files = (Array.isArray(result) ? result[0] : (result as Rolldown.RolldownOutput)).output;
  return {
    chunks: files.filter((file): file is Rolldown.OutputChunk => file.type === "chunk"),
    wasms: files.filter((file): file is Rolldown.OutputAsset => file.type === "asset" && file.fileName.endsWith(".wasm")),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Pubky's wasm in the app's builds", () => {
  it("ships as its own file, not as base64 in the chunk", async () => {
    const { chunks, wasms } = await buildPubky("Keypair");
    expect(wasms.map((file) => Buffer.from(file.source).equals(wasm))).toEqual([true]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].code.length).toBeLessThan(500_000);
    expect(chunks[0].code).not.toContain("__toBinary(\"AGFzbQ");
  }, 60_000);

  it("is fetched on first use and runs as the package's own build does, a failed fetch tried again", async () => {
    const { chunks, wasms } = await buildPubky();
    const url = `/${wasms[0].fileName}`;
    const fetched: string[] = [];
    let offline = true;
    vi.stubGlobal("fetch", async (requested: string) => {
      fetched.push(requested);
      return requested === url && !offline ? new Response(wasm, { headers: { "Content-Type": "application/wasm" } }) : new Response(null, { status: 503 });
    });
    // No top-level await: one turns off Rolldown's merging of shared chunks for the whole build. The chunk settles at once.
    const built = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(chunks[0].code).toString("base64")}`);
    expect(fetched).toEqual([]);
    await expect(built.pubkyWasmReady()).rejects.toThrow("pubky_bg.wasm: HTTP 503");
    offline = false;
    await built.pubkyWasmReady();
    await built.pubkyWasmReady();
    expect(fetched).toEqual([url, url]);
    const secret = new Uint8Array(32).fill(7);
    const own = require("@synonymdev/pubky") as typeof import("@synonymdev/pubky");
    expect(built.Keypair.fromSecret(secret).publicKey.z32()).toBe(own.Keypair.fromSecret(secret).publicKey.z32());
  }, 60_000);
});
