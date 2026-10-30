import type { DetectLanguages, LanguageGuess } from "./translateWhich";

/** The detector on the page: a block of about half a second as its module is evaluated. */
async function onPage(): Promise<DetectLanguages> {
  const { detectMultiple } = await import("@qvac/langdetect-text");
  return (text) => detectMultiple(text);
}

/** How long an answer is waited for: past it there is no guess, so Send and the messages after it do not wait for ever. */
export const DETECT_PATIENCE_MS = 10_000;

/** The detector in `worker`, or on the page once the worker fails, with what it had not answered. */
function inWorker(started: Worker): DetectLanguages {
  let worker: Worker | null = started;
  let page: Promise<DetectLanguages> | undefined;
  let next = 0;
  const waiting = new Map<number, { text: string; answer: (guesses: readonly LanguageGuess[]) => void }>();
  const elsewhere = async (text: string) => {
    try { return await (await (page ??= onPage()))(text); } catch { return []; }
  };
  started.addEventListener("message", ({ data }: MessageEvent<{ id: number; guesses: readonly LanguageGuess[] }>) => {
    waiting.get(data.id)?.answer(data.guesses);
    waiting.delete(data.id);
  });
  started.addEventListener("error", () => {
    started.terminate();
    worker = null;
    for (const { text, answer } of waiting.values()) void elsewhere(text).then(answer);
    waiting.clear();
  });
  return (text) => {
    if (!worker) return elsewhere(text);
    const to = worker;
    return new Promise((answer) => {
      const id = next++;
      const patience = setTimeout(() => { waiting.delete(id); answer([]); }, DETECT_PATIENCE_MS);
      waiting.set(id, { text, answer: (guesses) => { clearTimeout(patience); answer(guesses); } });
      to.postMessage({ id, text });
    });
  };
}

let loaded: Promise<DetectLanguages> | undefined;

/**
 * The language detector received messages and drafts are read with (translateWhich.ts takes it as a parameter):
 * `@qvac/langdetect-text`'s `detectMultiple`, started on the first message to translate and never in the start bundle.
 * One for the page, in a worker, as evaluating its dictionary would stop the page about half a second; on the page only
 * where no worker starts or its script does not load.
 */
export function loadDetector(): Promise<DetectLanguages | null> {
  // Read as written, so a build without translation carries no copy of the dictionary for the page.
  if (import.meta.env.VITE_TRANSLATE !== "1") return Promise.resolve(null);
  if (!loaded) {
    let worker: Worker | null = null;
    try { worker = new Worker(new URL("./translateDetector.worker.ts", import.meta.url), { type: "module" }); } catch { /* detected on the page */ }
    loaded = worker ? Promise.resolve(inWorker(worker)) : onPage();
    // A page's copy that did not load is tried again with the next one who asks.
    loaded.catch(() => { loaded = undefined; });
  }
  return loaded;
}
