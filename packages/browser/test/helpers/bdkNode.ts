import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadBdk } from "../../src/engine/paymentAdapters/providers/bdkSdk";

/** The same WebAssembly the app fetches, read from disk: Node has no Vite to serve it. */
export const nodeBdk = () => loadBdk(async () => ({
  glue: await import("@bitcoindevkit/bdk-wallet-web/bitcoindevkit_bg.js"),
  wasm: await readFile(createRequire(import.meta.url).resolve("@bitcoindevkit/bdk-wallet-web/bitcoindevkit_bg.wasm")),
}));
