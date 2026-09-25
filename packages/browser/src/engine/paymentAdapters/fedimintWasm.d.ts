/** The wasm-bindgen glue of the Fedimint client (`bundler` target), loaded by fedimintWorker.ts without its entry. */
declare module "@fedimint/fedimint-client-wasm-bundler/fedimint_client_wasm_bg.js" {
  export class RpcHandler {
    constructor(syncHandle: unknown);
    rpc(request: string, callback: (response: string) => void): void;
    free(): void;
  }
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
