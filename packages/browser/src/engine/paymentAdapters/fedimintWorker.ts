/**
 * One Fedimint client database, in a worker of its own: the Fedimint web SDK's worker, rewritten so the app can
 * load it without a WebAssembly bundler plugin and so it never logs a request (the SDK's own posts every payload
 * back as a log line, a mnemonic included). The module comes compiled from the page (`init.module`), the database
 * is one file of the origin-private file system (`init.dbPath`), held with an exclusive sync access handle.
 *
 * Messages are the SDK's transport protocol (`@fedimint/types` TransportRequest in, TransportMessage out), so
 * `@fedimint/core`'s TransportClient drives it unchanged.
 */
import * as glue from "@fedimint/fedimint-client-wasm-bundler/fedimint_client_wasm_bg.js";

const RPC_TYPES = new Set(["set_mnemonic", "generate_mnemonic", "get_mnemonic", "join_federation", "open_client", "close_client", "client_rpc", "cancel_rpc",
  "parse_invite_code", "parse_bolt11_invoice", "preview_federation", "parse_oob_notes", "has_mnemonic_set"]);

/** The part of a dedicated worker's global scope used here (the page's DOM types have no worker scope). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<{ type: string; payload?: Record<string, unknown>; requestId?: number }>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "unhandledrejection", listener: (event: PromiseRejectionEvent) => void): void;
}
interface SyncFile { close(): void }

let handler: glue.RpcHandler | undefined;
let file: SyncFile | undefined;
let database: string | undefined;
const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const { type, payload, requestId } = event.data;
  try {
    if (type === "init") {
      if (handler) { scope.postMessage({ type: "data", data: { filename: database }, request_id: requestId }); return; }
      const module = payload?.module as WebAssembly.Module | undefined;
      const dbPath = payload?.dbPath;
      if (!(module instanceof WebAssembly.Module) || typeof dbPath !== "string" || !/^ghostly-fedimint-[\w-]{1,80}\.db$/.test(dbPath)) throw new Error("Invalid Fedimint worker init");
      const instance = await WebAssembly.instantiate(module, { "./fedimint_client_wasm_bg.js": glue as unknown as WebAssembly.ModuleImports });
      glue.__wbg_set_wasm(instance.exports);
      (instance.exports.__wbindgen_start as (() => void) | undefined)?.();
      const root = await navigator.storage.getDirectory();
      const entry = await root.getFileHandle(dbPath, { create: true });
      // Exclusive: a second worker on the same file (another tab of this profile) fails here, before anything runs.
      file = await (entry as unknown as { createSyncAccessHandle(): Promise<SyncFile> }).createSyncAccessHandle();
      // wasm-bindgen's async constructor: `new` hands back a promise of the handler.
      handler = await (new glue.RpcHandler(file) as unknown as Promise<glue.RpcHandler>);
      database = dbPath;
      scope.postMessage({ type: "data", data: { filename: dbPath }, request_id: requestId });
    } else if (RPC_TYPES.has(type)) {
      if (!handler) { scope.postMessage({ type: "error", error: "The Fedimint client is not initialized", request_id: requestId }); return; }
      handler.rpc(JSON.stringify({ request_id: requestId, type, ...payload }), (response: string) => scope.postMessage(JSON.parse(response)));
    } else if (type === "cleanup") {
      file?.close();
      handler?.free();
      handler = undefined; file = undefined;
      scope.postMessage({ type: "data", data: { filename: database }, request_id: requestId });
      scope.close();
    } else {
      scope.postMessage({ type: "error", error: "Unknown message type", request_id: requestId });
    }
  } catch (error) {
    scope.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error), request_id: requestId });
  }
};

// A panic in the client aborts the task of the request that caused it: every request waiting on this worker is
// failed (no request id), rather than left to hang.
scope.addEventListener("error", (event) => { event.preventDefault(); scope.postMessage({ type: "error", error: `The Fedimint client stopped: ${event.message || "unknown error"}` }); });
scope.addEventListener("unhandledrejection", (event) => { event.preventDefault(); scope.postMessage({ type: "error", error: `The Fedimint client stopped: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}` }); });
