import { DEFAULT_RELAYS, LIMITS, parseLocalTarget, sanitizeFileName, sanitizeMime, toBase64Url, randomBytes } from "@ghostly/core";
import type { ServicesPlatform } from "../../../../src/lib/platform";
import { fileStore } from "../shared/idb";
import { TEST_MINT } from "../shared/mints";
import { getBrowserHost } from "../host";
import { engine } from "./engine";

/** Ephemeral services for the shared UI, backed by the browser peer. */
export const servicesPlatform: ServicesPlatform | null = {
  subscribe: (listener) => engine.subscribe(listener),

  isOnline: () => engine.state?.settings.online ?? false,
  setOnline: (online) => engine.call("updateSettings", { settings: { online } }),

  getSharedServices: () => engine.state?.services ?? [],

  async shareService(name, target) {
    const { origin } = parseLocalTarget(target);
    const url = new URL(origin);
    // Where the platform asks the user, it only does so from a user gesture: this has to come first.
    const granted = await getBrowserHost().requestLocalAccess(`${url.protocol}//${url.hostname}/*`);
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
  openService: (peerPubKeyZ32, serviceId) => getBrowserHost().openService(peerPubKeyZ32, serviceId),
  get features() {
    return getBrowserHost().features;
  },
  get notice() {
    return getBrowserHost().notice;
  },

  maxFileBytes: LIMITS.maxFileBytes,

  async sendFile(peerPubKeyZ32, source) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
    if (source.size > LIMITS.maxFileBytes) throw new Error("That file is too large to send");

    const file = {
      id: `${link.id}-${toBase64Url(randomBytes(12))}`,
      name: sanitizeFileName(source.name),
      size: source.size,
      mime: sanitizeMime(source.type),
    };
    // The page and the peer share this database; the bytes never go through a message.
    await fileStore.put({ id: file.id, linkId: link.id, blob: source, createdAt: Date.now() });
    const timestamp = Date.now();
    await engine.call("sendFile", { linkId: link.id, file, timestamp });
    return { timestamp, file };
  },
  getTransfer: (fileId) => engine.state?.transfers[fileId] ?? null,
  getFile: async (fileId) => (await fileStore.get(fileId))?.blob ?? null,

  wallet: {
    testMintUrl: TEST_MINT,
    getState: () => engine.state?.wallet ?? null,
    // The test mint is for trying things out right away, so it takes over as primary.
    addMint: async (url) => void (await engine.call("walletAddMint", { url, primary: url === TEST_MINT })),
    setPrimaryMint: (url) => engine.call("walletSetPrimaryMint", { url }),
    removeMint: (url) => engine.call("walletRemoveMint", { url }),
    receiveLightning: (amount) => engine.call("walletReceiveLightning", { amount }),
    quoteInvoice: (invoice) => engine.call("walletQuoteInvoice", { invoice }),
    payQuote: async (quote, mint) => (await engine.call("walletPayQuote", { quote, mint })).paid,
    receiveToken: async (token) => (await engine.call("walletReceiveToken", { token })).amount,
    exportTokens: () => engine.call("walletExport"),
    async send(peerPubKeyZ32, amount, memo) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const timestamp = Date.now();
      const { paymentId } = await engine.call("sendPayment", { linkId: link.id, amount, memo, timestamp });
      return { timestamp, paymentId };
    },
    async request(peerPubKeyZ32, amount, memo) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const timestamp = Date.now();
      const { paymentId } = await engine.call("requestPayment", { linkId: link.id, amount, memo, timestamp });
      return { timestamp, paymentId };
    },
    async payRequest(peerPubKeyZ32, paymentId) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      await engine.call("payRequest", { linkId: link.id, paymentId });
    },
    reclaim: (paymentId) => engine.call("reclaimPayment", { paymentId }),
    getPayment: (paymentId) => engine.state?.payments[paymentId] ?? null,
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
