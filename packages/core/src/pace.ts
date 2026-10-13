/**
 * Long work on a thread the page draws and takes input on (the web engine shares its page's thread), done in slices
 * with the thread let go between them.
 */

/**
 * Lets the thread go for one turn: what waits (input, drawing) runs, then the caller goes on. `scheduler.yield()` where
 * there is one, else a message to itself. Never `setTimeout(0)`: from the fifth nested timer on the browser waits at
 * least 4 ms (HTML's clamp), which made a paced read of 4096 revocations take 60% longer than the work, and a hidden
 * tab runs timers once a second.
 */
export function yieldThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A pause for a loop of short steps: `await pause()` after each step lets the thread go once `sliceMs` of work has
 * run since the last time, and answers at once otherwise.
 */
export function pacer(sliceMs: number): () => Promise<void> | undefined {
  let since = performance.now();
  return () => {
    if (performance.now() - since < sliceMs) return undefined;
    return yieldThread().then(() => {
      since = performance.now();
    });
  };
}
