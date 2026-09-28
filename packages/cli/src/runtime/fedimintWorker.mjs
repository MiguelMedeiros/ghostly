/**
 * One Fedimint client database on Node, in a `worker_threads` worker of its own: the browser's worker
 * (packages/browser/src/engine/paymentAdapters/fedimintWorker.ts) with a file of the profile in place of the
 * origin-private file system. Plain JavaScript: it runs as it is, from the workspace and beside the bundle.
 *
 * The client's WebAssembly reads and writes its database through a sync access handle, and calls only `read`,
 * `write` (each with `{ at }`), `getSize`, `truncate`, `flush` and `close` on it: `SyncFile` is those, on a file
 * descriptor. Its network is `fetch` and `WebSocket`, which Node has; `CloseEvent`, which Node 22 lacks, is given here.
 *
 * `workerData`: `{ dir, glue }`, the folder of the databases and the `file:` URL of the wasm-bindgen glue. Messages
 * are the SDK's transport protocol, as in the browser; `init` brings the compiled module and the database's name.
 */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const RPC_TYPES = new Set(["set_mnemonic", "generate_mnemonic", "get_mnemonic", "join_federation", "open_client", "close_client", "client_rpc", "cancel_rpc",
  "parse_invite_code", "parse_bolt11_invoice", "preview_federation", "parse_oob_notes", "has_mnemonic_set"]);

/** A FileSystemSyncAccessHandle, as much of one as the client uses. */
class SyncFile {
  position = 0;
  constructor(path) { this.fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600); }
  read(buffer, options) {
    let at = options?.at ?? this.position, done = 0;
    while (done < buffer.byteLength) {
      const n = readSync(this.fd, buffer, done, buffer.byteLength - done, at + done);
      if (n === 0) break;
      done += n;
    }
    this.position = at + done;
    return done;
  }
  write(buffer, options) {
    const at = options?.at ?? this.position;
    let done = 0;
    while (done < buffer.byteLength) done += writeSync(this.fd, buffer, done, buffer.byteLength - done, at + done);
    this.position = at + done;
    return done;
  }
  getSize() { return fstatSync(this.fd).size; }
  truncate(size) { ftruncateSync(this.fd, size); if (this.position > size) this.position = size; }
  flush() { fsyncSync(this.fd); }
  close() { if (this.fd !== undefined) closeSync(this.fd); this.fd = undefined; }
}

globalThis.CloseEvent ??= class CloseEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.code = init.code ?? 0;
    this.reason = init.reason ?? "";
    this.wasClean = !!init.wasClean;
  }
};

const glue = await import(workerData.glue);
let handler, file, database;
const post = (message) => parentPort.postMessage(message);

parentPort.on("message", async ({ type, payload, requestId }) => {
  try {
    if (type === "init") {
      if (handler) { post({ type: "data", data: { filename: database }, request_id: requestId }); return; }
      const module = payload?.module;
      const dbPath = payload?.dbPath;
      if (!(module instanceof WebAssembly.Module) || typeof dbPath !== "string" || !/^ghostly-fedimint-[\w-]{1,80}\.db$/.test(dbPath)) throw new Error("Invalid Fedimint worker init");
      const instance = await WebAssembly.instantiate(module, { "./fedimint_client_wasm_bg.js": glue });
      glue.__wbg_set_wasm(instance.exports);
      instance.exports.__wbindgen_start?.();
      file = new SyncFile(join(workerData.dir, dbPath));
      // wasm-bindgen's async constructor: `new` hands back a promise of the handler.
      handler = await new glue.RpcHandler(file);
      database = dbPath;
      post({ type: "data", data: { filename: dbPath }, request_id: requestId });
    } else if (RPC_TYPES.has(type)) {
      if (!handler) { post({ type: "error", error: "The Fedimint client is not initialized", request_id: requestId }); return; }
      handler.rpc(JSON.stringify({ request_id: requestId, type, ...payload }), (response) => post(JSON.parse(response)));
    } else if (type === "cleanup") {
      file?.close();
      handler?.free();
      handler = undefined; file = undefined;
      post({ type: "data", data: { filename: database }, request_id: requestId });
      parentPort.close();
    } else {
      post({ type: "error", error: "Unknown message type", request_id: requestId });
    }
  } catch (error) {
    post({ type: "error", error: error instanceof Error ? error.message : String(error), request_id: requestId });
  }
});

// As in the browser: a panic fails every request waiting on this worker (no request id), rather than leave it to hang.
const stopped = (error) => post({ type: "error", error: `The Fedimint client stopped: ${error instanceof Error ? error.message : String(error)}` });
process.on("uncaughtException", stopped);
process.on("unhandledRejection", stopped);
