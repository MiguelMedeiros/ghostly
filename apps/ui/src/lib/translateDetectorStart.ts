/**
 * The language detector's worker, started. A module of its own, imported only by a build with translation
 * (translateDetector.ts): the build emits a worker's script wherever `new Worker(new URL(…))` is written, before any
 * dead code is dropped, so in translateDetector.ts every build carried its 2 MB, the extension's and Android's too.
 */
export function startDetectorWorker(): Worker {
  return new Worker(new URL("./translateDetector.worker.ts", import.meta.url), { type: "module" });
}
