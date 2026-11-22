/**
 * A running app's port, relayed between the runner's frame and the broker by a thread of the page's own (a worker), so
 * the app's sending rate is counted where the app cannot hold the count back.
 *
 * Where the runner's frame shares the page's thread (Firefox keeps a sandboxed frame in its parent's process, WebKit
 * has one thread for both), an app that sends in a loop hands that thread back so seldom that its messages reach the
 * page a dozen a second, however many it sends: the broker's count never sees the flood, and what waits in the port
 * grows by gigabytes until the watchdog stops the app. A worker receives them as they come, and closes the port past
 * the limit before the page sees any more of them.
 */

/** What the worker is sent once: the app's port, the broker's end and the limit. */
export interface RelayStart {
  app: MessagePort;
  page: MessagePort;
  perSecond: number;
}

/** The worker's one word to the page: the app sent past the limit, and its port is closed. */
export const FLOODED = "flooded";

/**
 * Relays `app` (the frame's end) and `page` (the broker's) both ways. Every message from the app is counted, malformed
 * ones too, before it is read; past `perSecond` in one second both ports close, so nothing more of the app's is read or
 * passed on, and `flooded` is called. A buffer the page answers with is passed on, not copied.
 */
export function relayAppPort({ app, page, perSecond }: RelayStart, flooded: () => void, now = () => performance.now()): void {
  const recent: number[] = [];
  let open = true;
  const counted = () => {
    if (!open) return false;
    const at = now();
    recent.push(at);
    while (recent.length && recent[0]! <= at - 1000) recent.shift();
    if (recent.length <= perSecond) return true;
    open = false;
    app.close();
    page.close();
    flooded();
    return false;
  };
  app.onmessage = (event) => { if (counted()) page.postMessage(event.data); };
  // What could not be read reaches the broker as what it is: not a request.
  app.onmessageerror = () => { if (counted()) page.postMessage(null); };
  page.onmessage = (event) => {
    if (!open) return;
    const data = event.data as { value?: unknown } | null;
    const value = data && typeof data === "object" ? data.value : undefined;
    try { app.postMessage(data, value instanceof ArrayBuffer ? [value] : []); } catch { /* closed */ }
  };
}
