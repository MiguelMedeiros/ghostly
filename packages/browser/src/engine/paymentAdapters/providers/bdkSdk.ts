import type * as BdkModule from "@bitcoindevkit/bdk-wallet-web";

/** BDK (bitcoindevkit) compiled to WebAssembly: `@bitcoindevkit/bdk-wallet-web`. */
export type Bdk = typeof BdkModule;
/** Where the glue and the module come from: the app fetches them; a Node test reads them from disk. */
export type BdkLoader = () => Promise<{ glue: Bdk & { __wbg_set_wasm(exports: WebAssembly.Exports): void }; wasm: Response | BufferSource }>;

const WASM_IMPORTS = "./bitcoindevkit_bg.js";

const appLoader: BdkLoader = async () => {
  const [glue, url] = await Promise.all([
    // @ts-expect-error The glue ships no types of its own: its API is the package's (Bdk).
    import("@bitcoindevkit/bdk-wallet-web/bitcoindevkit_bg.js") as Promise<Awaited<ReturnType<BdkLoader>>["glue"]>,
    import("@bitcoindevkit/bdk-wallet-web/bitcoindevkit_bg.wasm?url"),
  ]);
  return { glue, wasm: await fetch(url.default) };
};

let loading: Promise<Bdk> | undefined;

/**
 * Loads the WebAssembly once, on first use: profiles that never set up a BDK wallet never fetch its 2 MB.
 * The package is wasm-pack's `bundler` build, whose entry imports the `.wasm` as an ES module (which
 * Vite does not do without a plugin), so the glue is loaded alone and handed the instance here, the way
 * that entry would.
 */
export function loadBdk(loader: BdkLoader = appLoader): Promise<Bdk> {
  return loading ??= (async () => {
    const { glue, wasm } = await loader();
    const imports = { [WASM_IMPORTS]: glue as unknown as WebAssembly.ModuleImports };
    let instance: WebAssembly.Instance;
    if (wasm instanceof Response) {
      // A server that sends the wrong MIME type (or none) cannot stream: compile from the bytes instead.
      try { instance = (await WebAssembly.instantiateStreaming(wasm.clone(), imports)).instance; }
      catch { instance = (await WebAssembly.instantiate(await wasm.arrayBuffer(), imports)).instance; }
    } else instance = (await WebAssembly.instantiate(wasm, imports)).instance;
    glue.__wbg_set_wasm(instance.exports);
    (instance.exports.__wbindgen_start as (() => void) | undefined)?.();
    return glue;
  })().catch((error) => { loading = undefined; throw error; });
}
