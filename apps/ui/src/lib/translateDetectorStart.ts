/**
 * The language detector's worker, started (translateDetector.ts). A module of its own: a build keeps a worker's file
 * only while a module of the bundle names it, so a build without translation, which calls this nowhere, writes none.
 */
export function startDetectorWorker(): Worker {
  return new Worker(new URL("./translateDetector.worker.ts", import.meta.url), { type: "module" });
}
