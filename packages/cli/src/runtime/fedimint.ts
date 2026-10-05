import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { fedimintSdkOn, type FedimintSdk } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";

/**
 * The Fedimint client on Node (WISP 1100 § Wallet SDKs on Node): the app's own SDK and WebAssembly, each database in
 * a `worker_threads` worker (fedimintWorker.mjs) and a file of the profile's `fedimint/` folder, where the browser has
 * a module worker and the origin-private file system. Only the platform differs: the client and what the engine does
 * with it are the app's.
 */

const WASM_PACKAGE = "@fedimint/fedimint-client-wasm-bundler";
const DATABASE = /^ghostly-fedimint-[\w-]{1,80}\.db$/;

/** The worker's file: beside this chunk wherever the bundler put it (the entry, or assets/), else the workspace's. */
function workerFile(): URL {
  for (const place of ["./fedimintWorker.mjs", "./assets/fedimintWorker.mjs"]) {
    const url = new URL(place, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  throw new Error("The Fedimint worker is missing from this build");
}

let compiling: Promise<WebAssembly.Module> | undefined;
/** Compiled once per process (11 MB): each worker is handed the module, not the bytes. */
function compiled(): Promise<WebAssembly.Module> {
  return compiling ??= WebAssembly.compile(readFileSync(createRequire(import.meta.url).resolve(`${WASM_PACKAGE}/fedimint_client_wasm_bg.wasm`)))
    .catch((error) => { compiling = undefined; throw error; });
}

function databasePath(dir: string, database: string): string {
  if (!DATABASE.test(database)) throw new Error("Invalid Fedimint database name");
  return join(dir, database);
}

/** The SDK on this profile's folder `dir`. Loaded on first use, as in the app: a bot that joins no federation compiles nothing. */
export function nodeFedimintSdk(dir: string): () => Promise<FedimintSdk> {
  let loading: Promise<FedimintSdk> | undefined;
  return () => loading ??= (async () => {
    const [{ Transport }, module] = await Promise.all([import("@fedimint/types"), compiled()]);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const glue = pathToFileURL(createRequire(import.meta.url).resolve(`${WASM_PACKAGE}/fedimint_client_wasm_bg.js`)).href;
    const worker = workerFile();
    type Message = { type: string; payload?: unknown; requestId?: number };
    class ThreadTransport extends Transport {
      readonly logger = { debug() {}, info() {}, warn() {}, error() {} };
      private readonly thread = new Worker(worker, { workerData: { dir, glue } });
      /** Why the thread ended, once it has: later requests fail with it rather than wait on nothing. */
      private ended: string | undefined;
      constructor() {
        super();
        this.thread.on("message", (message) => this.messageHandler(message));
        this.thread.on("error", (error: unknown) => this.end(`The Fedimint client stopped: ${(error instanceof Error && error.message) || "unknown error"}`));
        this.thread.on("exit", () => this.end("The Fedimint client stopped"));
      }
      private end(error: string) {
        if (this.ended) return;
        this.ended = error;
        this.messageHandler({ type: "error", error });
      }
      postMessage(message: Message) {
        const ended = this.ended;
        if (ended) { queueMicrotask(() => this.messageHandler({ type: "error", error: ended, request_id: message.requestId })); return; }
        this.thread.postMessage(message.type === "init" ? { ...message, payload: { ...(message.payload as object), module } } : message);
      }
      terminate() { this.ended ??= "The Fedimint client was closed"; void this.thread.terminate(); }
    }
    return fedimintSdkOn({
      transport: async () => new ThreadTransport(),
      async exists(database) {
        try { return statSync(databasePath(dir, database)).size > 0; } catch { return false; }
      },
      async remove(database) { rmSync(databasePath(dir, database), { force: true }); },
    });
  })().catch((error) => { loading = undefined; throw error; });
}
