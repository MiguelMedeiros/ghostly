import { FLOODED, relayAppPort, type RelayStart } from "./portRelay";

/**
 * A running app's channel, relayed (portRelay.ts): `port2` goes to the runner's frame, `port1` is the broker's (the
 * first channel's, as with one MessageChannel), and in between a worker counts what the app sends on a thread of its
 * own and calls `flooded` past `perSecond` in a second. The ports go to the worker once it runs; where no worker starts
 * or its script does not load, the same relay runs on the page. `end` stops it.
 */
export function relayedChannel(perSecond: number, flooded: () => void): { port1: MessagePort; port2: MessagePort; end(): void } {
  const inner = new MessageChannel();
  const app = new MessageChannel();
  const start: RelayStart = { app: app.port1, page: inner.port2, perSecond };
  let worker: Worker | null = null;
  let sent = false;
  let ended = false;
  const onPage = () => {
    worker?.terminate();
    worker = null;
    if (sent || ended) return;
    sent = true;
    relayAppPort(start, flooded);
  };
  try { worker = new Worker(new URL("./portRelay.worker.ts", import.meta.url), { type: "module" }); } catch { /* relayed on the page */ }
  if (worker) {
    const started = worker;
    started.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data === "ready" && !sent && !ended) { sent = true; started.postMessage(start, [app.port1, inner.port2]); }
      else if (data === FLOODED) flooded();
    };
    started.onerror = onPage;
  } else onPage();
  return {
    port1: inner.port1,
    port2: app.port2,
    end() {
      ended = true;
      worker?.terminate();
      worker = null;
      app.port1.close();
      inner.port2.close();
    },
  };
}
