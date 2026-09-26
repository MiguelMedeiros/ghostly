import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * `fetch` for `file:` URLs, which Node's does not do. The wallet SDKs' WebAssembly (Bark, BDK, Breez, Iroh) is loaded
 * the way a page loads it, `fetch(new URL("…wasm", import.meta.url))`; on Node that URL is a file beside the bundle.
 * Only `.wasm` files are answered, and nothing else of fetch changes.
 */
export function installFileFetch(): void {
  const original = globalThis.fetch;
  const patched: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("file:")) {
      if (!url.endsWith(".wasm")) throw new TypeError(`Refusing to fetch ${url}`);
      const bytes = await readFile(fileURLToPath(url));
      return new Response(bytes, { headers: { "content-type": "application/wasm" } });
    }
    return original(input, init);
  };
  globalThis.fetch = patched;
}
