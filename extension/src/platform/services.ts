import { DEFAULT_RELAYS, parseLocalTarget } from "@ghostly/core";
import type { ServicesPlatform } from "../../../src/lib/platform";
import type { RuntimeMessage } from "../shared/rpc";
import { engine } from "./engine";

/** Ephemeral services for the shared UI, backed by the peer in the offscreen document. */
export const servicesPlatform: ServicesPlatform | null = {
  subscribe: (listener) => engine.subscribe(listener),

  isOnline: () => engine.state?.settings.online ?? false,
  setOnline: (online) => engine.call("updateSettings", { settings: { online } }),

  getSharedServices: () => engine.state?.services ?? [],

  async shareService(name, target) {
    const { origin } = parseLocalTarget(target);
    const url = new URL(origin);
    // Chrome only prompts from a user gesture, so this has to come first.
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (!granted) throw new Error("Ghostly needs your permission to reach that local address");
    await engine.call("addService", { name, target });
  },
  removeService: (serviceId) => engine.call("removeService", { serviceId }),
  setServiceEnabled: (serviceId, enabled) => engine.call("setServiceEnabled", { serviceId, enabled }),

  getPeer(peerPubKeyZ32) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    return link ? { dataLink: link.dataLink, online: link.peerOnline, services: link.peerServices } : null;
  },
  connect(peerPubKeyZ32) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (link) void engine.call("connect", { linkId: link.id }).catch(() => {});
  },
  async openService(peerPubKeyZ32, serviceId) {
    const reply = await chrome.runtime.sendMessage({
      target: "background",
      type: "open-service",
      peerPubKeyZ32,
      serviceId,
    } satisfies RuntimeMessage);
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not open the service");
  },

  getNetwork() {
    const state = engine.state;
    if (!state) return null;
    return {
      protocol: state.transport.protocol,
      relays: state.settings.relays,
      defaultRelays: DEFAULT_RELAYS,
      turn: state.settings.iceServers[0] ?? null,
    };
  },
  setNetwork: ({ relays, turn }) =>
    engine.call("updateSettings", { settings: { relays, iceServers: turn?.urls ? [turn] : [] } }),
};
