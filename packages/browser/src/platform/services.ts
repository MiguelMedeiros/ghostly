import {
  DEFAULT_RELAYS,
  LIMITS,
  parseLocalTarget,
  safeBlobType,
  sanitizeFileName,
  sanitizeMime,
  toBase64Url,
  randomBytes,
} from "@ghostly/core";
import type { ServicesPlatform } from "../../../../src/lib/platform";
import { fileStore } from "../shared/idb";
import { TEST_MINT, TEST_MINTS } from "../shared/mints";
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
  setServiceShared: (serviceId, peerPubKeyZ32, shared) => engine.call("setServiceShared", { serviceId, peerPubKeyZ32, shared }),

  getPeer(peerPubKeyZ32) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    return link ? { id: link.id, deliveryMode: link.deliveryMode, textDelivery: link.textDelivery, canSendText: link.canSendText, dhtDelivery: link.dhtDelivery, hold: link.hold, capabilities: link.capabilities, paymentMethods: link.paymentMethods, pairing: link.pairing, dataLink: link.dataLink, online: link.peerOnline, services: link.peerServices } : null;
  },
  async setChatPaymentMethods(peerPubKeyZ32, methods) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
    await engine.call("setChatPaymentMethods", { linkId: link.id, methods });
  },
  async setChatHold(peerPubKeyZ32, enabled) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
    await engine.call("setChatHold", { linkId: link.id, enabled });
  },
  setHoldStorage: (holdStorage) => engine.call("updateSettings", { settings: { holdStorage } }),
  connect(peerPubKeyZ32) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (link) void engine.call("connect", { linkId: link.id }).catch(() => {});
  },
  openService: (peerPubKeyZ32, serviceId) => getBrowserHost().openService(peerPubKeyZ32, serviceId),
  openPaymentLink(uri) {
    const open = getBrowserHost().openPaymentLink;
    return open ? open(uri) : null;
  },
  shareText(text, anchor) {
    const share = getBrowserHost().shareText;
    return share ? share(text, anchor) : null;
  },
  readClipboardText() {
    const read = getBrowserHost().readClipboardText;
    return read ? read() : null;
  },
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
    if (link.profile && !link.capabilities?.files) throw new Error("Connect to an updated peer to send files");
    if (source.size > LIMITS.maxFileBytes) throw new Error("That file is too large to send");

    const wireId = toBase64Url(randomBytes(12));
    const file = {
      // Its own key space: nothing a peer sends can land on this id.
      id: `${link.id}-out-${wireId}`,
      name: sanitizeFileName(source.name),
      size: source.size,
      mime: sanitizeMime(source.type),
    };
    // The page and the peer share this database; the bytes never go through a message.
    const timestamp = Date.now();
    await fileStore.put({ id: file.id, linkId: link.id, blob: source, createdAt: timestamp, direction: "out", wireId,
      metadata: { name: file.name, size: file.size, mime: file.mime, timestamp },
      transfer: { state: "transferring", transferred: 0, size: file.size } });
    await engine.call("sendFile", { linkId: link.id, file, timestamp });
    return { timestamp, file };
  },
  async retryFile(fileId) {
    const stored = await fileStore.get(fileId);
    if (!stored?.metadata || stored.direction !== "out") throw new Error("This file cannot be retried");
    const link = engine.state?.links.find(link => link.id === stored.linkId);
    if (!link || (link.profile && !link.capabilities?.files)) throw new Error("Connect to an updated peer first");
    await engine.call("sendFile", { linkId: stored.linkId, file: { id: fileId, ...stored.metadata }, timestamp: stored.metadata.timestamp });
  },
  async deleteMessage(peerPubKeyZ32, messageId) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (link) await engine.call("deleteMessage", { linkId: link.id, messageId });
  },
  getTransfer: (fileId) => engine.state?.transfers[fileId] ?? null,
  async getFile(fileId) {
    const blob = (await fileStore.get(fileId))?.blob;
    // Files stored before received types were cleaned up may still carry the peer's type.
    return blob ? blob.slice(0, blob.size, safeBlobType(blob.type)) : null;
  },

  wallet: {
    usdtCreate:params=>engine.call("usdtCreate",params),
    usdtUnlock:password=>engine.call("usdtUnlock",{password}),
    usdtReveal:password=>engine.call("usdtReveal",{password}),
    usdtLock:()=>engine.call("usdtLock"),
    usdtRefresh:()=>engine.call("usdtRefresh"),
    usdtGetTestTokens:()=>engine.call("usdtGetTestTokens"),
    usdtExportBackup:password=>engine.call("usdtExportBackup",{password}),
    usdtRestoreBackup:(text,password)=>engine.call("usdtRestoreBackup",{text,password}),
    arkCreate: (params) => engine.call("arkCreate",params),
    arkUnlock: (password) => engine.call("arkUnlock",{password}),
    arkLock: () => engine.call("arkLock"),
    arkBackup: (password) => engine.call("arkBackup",{password}),
    arkExportBackup:(password)=>engine.call("arkExportBackup",{password}),
    arkRestoreBackup:(text,password)=>engine.call("arkRestoreBackup",{text,password}),
    arkRefresh: () => engine.call("arkRefresh"),
    arkRecover: () => engine.call("arkRecover"),
    barkCreate: (params) => engine.call("barkCreate",params),
    barkBackup: () => engine.call("barkBackup"),
    barkExportBackup: (password) => engine.call("barkExportBackup",{password}),
    barkRestoreBackup: (text,password) => engine.call("barkRestoreBackup",{text,password}),
    barkRefresh: () => engine.call("barkRefresh"),
    barkBoard: () => engine.call("barkBoard"),
    preparePayment: (params) => engine.call("preparePayment",params),
    approvePayment: (id) => engine.call("approvePayment",{id}),
    reconcilePayment: (id) => engine.call("reconcilePayment",{id}),
    cancelPayment: (id) => engine.call("cancelPayment",{id}),

    testMintUrl: TEST_MINT,
    testMintUrls: TEST_MINTS,
    getState: () => engine.state?.wallet ?? null,
    // The test mint is for trying things out right away, so it takes over as primary.
    addMint: async (url) => void (await engine.call("walletAddMint", { url, primary: TEST_MINTS.includes(url) })),
    setPrimaryMint: (url) => engine.call("walletSetPrimaryMint", { url }),
    setMode: (mode) => engine.call("walletSetMode", { mode }),
    removeMint: (url) => engine.call("walletRemoveMint", { url }),
    receiveLightning: (amount, via) => engine.call("walletReceiveLightning", { amount, via }),
    quoteInvoice: (invoice, via) => engine.call("walletQuoteInvoice", { invoice, via }),
    lightningSetSource: (providerId, values) => engine.call("lightningSetSource", { providerId, values }),
    lightningClearSource: () => engine.call("lightningClearSource"),
    lightningRetrySource: () => engine.call("lightningRetrySource"),
    lightningReconfigureSource: (values) => engine.call("lightningReconfigureSource", { values }),
    bitcoinSetSource: (providerId, values) => engine.call("bitcoinSetSource", { providerId, values }),
    bitcoinClearSource: () => engine.call("bitcoinClearSource"),
    bitcoinRetrySource: () => engine.call("bitcoinRetrySource"),
    bitcoinReconfigureSource: (values) => engine.call("bitcoinReconfigureSource", { values }),
    bitcoinReceiveAddress: () => engine.call("bitcoinReceiveAddress"),
    bitcoinRefresh: () => engine.call("bitcoinRefresh"),
    payQuote: async (quote, mint, note) => (await engine.call("walletPayQuote", { quote, mint, note })).paid,
    resolveLightningAddress: (text) => engine.call("lnurlResolve", { text }),
    lightningAddressInvoice: (id, amount, comment) => engine.call("lnurlInvoice", { id, amount, comment }),
    async checkPayment(peerPubKeyZ32, paymentId) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      await engine.call("checkPayment", { linkId: link.id, paymentId });
    },
    receiveToken: async (token) => (await engine.call("walletReceiveToken", { token })).amount,
    inspectCashu: async (text) => (await engine.call("walletInspectCashu", { text })).inspection,
    exportTokens: () => engine.call("walletExport"),
    async send(peerPubKeyZ32, amount, memo) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const timestamp = Date.now();
      const { paymentId } = await engine.call("sendPayment", { linkId: link.id, amount, memo, timestamp });
      return { timestamp, paymentId };
    },
    async request(peerPubKeyZ32, amount, memo, method) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const timestamp = Date.now();
      const { paymentId } = await engine.call("requestPayment", { linkId: link.id, amount, memo, timestamp, method });
      return { timestamp, paymentId };
    },
    async payRequest(peerPubKeyZ32, paymentId, options) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      await engine.call("payRequest", { linkId: link.id, paymentId, ...options });
    },
    reclaim: (paymentId) => engine.call("reclaimPayment", { paymentId }),
    getPayment: (paymentId) => engine.state?.payments[paymentId] ?? null,
    async askToPay(peerPubKeyZ32, amount, method, memo) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      return engine.call("askToPay", { linkId: link.id, amount, method, memo, timestamp: Date.now() });
    },
    answerTo: (askId) => Object.values(engine.state?.payments ?? {}).find((p) => p.ask === askId && p.kind === "request" && p.direction === "in") ?? null,
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
