import { FLOODED, relayAppPort, type RelayStart } from "./portRelay";

/** Relays one running app's port off the page's thread (portRelay.ts): says it is ready, then takes the ports once. */
self.onmessage = (event: MessageEvent<RelayStart>) => {
  self.onmessage = null;
  relayAppPort(event.data, () => self.postMessage(FLOODED));
};
self.postMessage("ready");
