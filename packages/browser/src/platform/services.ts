import {
  DEFAULT_RELAYS,
  LIMITS,
  formatFileSize,
  parseLocalTarget,
  safeBlobType,
  sanitizeFileName,
  sanitizeMime,
  parseVideoMeta,
  readImageMeta,
  parseVoiceMeta,
  toBase64Url,
  randomBytes,
} from "@ghostly/core";
import type { ServicesPlatform, WalletPlatform } from "../../../../apps/ui/src/lib/platform";
import type { WalletNetwork } from "@ghostly/core";
import { fileStore } from "../shared/idb";
import { SMALL_FILE_BYTES, blobDigest, fileBytes, fileBytesOf } from "../shared/fileBytes";
import { storedBlob } from "../shared/storedFiles";
import type { FileTransferState } from "../../../../apps/ui/src/lib/platform";
import { DEFAULT_HYPERDHT_RELAY } from "../shared/hyperdhtRelay";
import { TEST_MINT, TEST_MINTS } from "../shared/mints";
import { getBrowserHost } from "../host";
import { engine } from "./engine";

/**
 * Large files being copied into file storage before they are offered (this page does it): the bubble shows
 * how far the copy got. Gone once the peer has the file, or with the reason the copy failed.
 */
const preparing = new Map<string, FileTransferState>();
/**
 * The last few files sent from this page, as they were handed over (a recording, a paste, a pick): their bubble shows
 * them at once from these bytes, without reading the stored copy back. Small files only; gone on a reload.
 */
const justSent = new Map<string, Blob>();
const JUST_SENT_MAX = 8;
function keepJustSent(id: string, blob: Blob): void {
  justSent.set(id, blob);
  while (justSent.size > JUST_SENT_MAX) justSent.delete(justSent.keys().next().value!);
}
/** A stored service target's origin (`http://localhost:3400`), or null for one that no longer parses. */
function originOf(target: string | undefined): string | null {
  if (!target) return null;
  try { return parseLocalTarget(target).origin; } catch { return null; }
}

const preparingListeners = new Set<() => void>();
let preparingTold = 0;
function preparingChanged(force = false): void {
  const now = Date.now();
  if (!force && now - preparingTold < 250) return;
  preparingTold = now;
  for (const listener of preparingListeners) listener();
}

/**
 * Saves bytes kept in memory (a small received file, a voice message made MP3 here) through the system's save
 * dialog where files are real files (Desktop): a copy staged next to them, saved, and removed only once the save
 * has finished (the command answers after the dialog and the copy). Null where there is no such dialog. A dialog that
 * never answers keeps the copy until the app next starts, which removes every `save-` copy
 * (`remove_staged_saves` in apps/desktop/src/file_store.rs).
 */
async function saveStaged(blob: Blob, name: string): Promise<boolean | null> {
  const native = await fileBytesOf("native");
  if (!native?.save) return null;
  const copy = `save-${crypto.randomUUID()}`;
  try {
    await native.stage(copy, blob);
    return await native.save(copy, name);
  } finally {
    await native.remove(copy).catch(() => {});
  }
}

/** Ephemeral services for the shared UI, backed by the browser peer. */
/**
 * The wallet calls, acting on one network's wallets when bound to it (the card they are made on), else on the
 * network older pages showed. A payment still goes through the wallet of its own network either way.
 */
function walletPlatform(network?: WalletNetwork, card?: string): WalletPlatform {
  const on = network ? { network } : undefined;
  // The Lightning calls of a platform bound to one card go through it; unbound, through the network's default.
  const ln = { ...on, ...(card ? { card } : {}) };
  const bound = () => { if (!network || !card) throw new Error("Pick a Lightning card first"); return { network, card }; };
  return {
    network,
    lightningCard: card,
    forNetwork: (next) => walletPlatform(next),
    forLightning: (next) => walletPlatform(network, next),
    lightningSetReceive: () => engine.call("lightningSetReceive", bound()),
    lightningRename: (name) => engine.call("lightningRename", { ...bound(), name }),
    create: (params) => engine.call("walletCreate", params),
    remove: (params) => engine.call("walletRemove", params),
    testCoins: (params) => engine.call("walletTestCoins", params),
    setupRetry: (type) => engine.call("walletSetupRetry", { type }),
    setupDismiss: (type) => engine.call("walletSetupDismiss", { type }),
    usdtCreate:params=>engine.call("usdtCreate",params),
    usdtUnlock:password=>engine.call("usdtUnlock",{password,...(network?{network}:{})}),
    usdtReveal:password=>engine.call("usdtReveal",{password,...(network?{network}:{})}),
    usdtLock:()=>engine.call("usdtLock",on),
    usdtRefresh:()=>engine.call("usdtRefresh",on),
    usdtExportBackup:password=>engine.call("usdtExportBackup",{password,...(network?{network}:{})}),
    usdtRestoreBackup:(text,password)=>engine.call("usdtRestoreBackup",{text,password,...(network?{network}:{})}),
    arkCreate: (params) => engine.call("arkCreate",params),
    arkUnlock: (password) => engine.call("arkUnlock",{password,...(network?{network}:{})}),
    arkLock: () => engine.call("arkLock",on),
    arkBackup: (password) => engine.call("arkBackup",{password,...(network?{network}:{})}),
    arkExportBackup:(password)=>engine.call("arkExportBackup",{password,...(network?{network}:{})}),
    arkRestoreBackup:(text,password)=>engine.call("arkRestoreBackup",{text,password,...(network?{network}:{})}),
    arkRefresh: () => engine.call("arkRefresh",on),
    arkRecover: () => engine.call("arkRecover",on),
    barkCreate: (params) => engine.call("barkCreate",params),
    barkBackup: () => engine.call("barkBackup",on),
    barkExportBackup: (password) => engine.call("barkExportBackup",{password,...(network?{network}:{})}),
    barkRestoreBackup: (text,password) => engine.call("barkRestoreBackup",{text,password,...(network?{network}:{})}),
    barkRefresh: () => engine.call("barkRefresh",on),
    barkBoard: () => engine.call("barkBoard",on),
    fedimintPreview: (invite) => engine.call("fedimintPreview", { invite, ...(network?{network}:{}) }),
    fedimintJoin: (invite, recover) => engine.call("fedimintJoin", { invite, recover, ...(network?{network}:{}) }),
    fedimintLeave: (federation) => engine.call("fedimintLeave", { federation }),
    fedimintRefresh: () => engine.call("fedimintRefresh", on),
    fedimintSpendNotes: (federation, amount, confirmedReal) => engine.call("fedimintSpendNotes", { federation, amount, ...(confirmedReal ? { confirmedReal: true as const } : {}) }),
    fedimintReceiveNotes: (notes) => engine.call("fedimintReceiveNotes", { notes, ...(network?{network}:{}) }),
    fedimintInvoice: (federation, amount, memo) => engine.call("fedimintInvoice", { federation, amount, memo }),
    fedimintTakeBack: (federation, operation) => engine.call("fedimintTakeBack", { federation, operation }),
    fedimintBackup: () => engine.call("fedimintBackup", on),
    fedimintExportBackup: (password) => engine.call("fedimintExportBackup", { password, ...(network?{network}:{}) }),
    fedimintRestoreBackup: (text, password) => engine.call("fedimintRestoreBackup", { text, password, ...(network?{network}:{}) }),
    fedimintRestorePhrase: (mnemonic, invites) => engine.call("fedimintRestorePhrase", { mnemonic, invites, ...(network?{network}:{}) }),
    sparkCreate: (params) => engine.call("sparkCreate",params),
    sparkBackup: () => engine.call("sparkBackup",on),
    sparkExportBackup: (password) => engine.call("sparkExportBackup",{password,...(network?{network}:{})}),
    sparkRestoreBackup: (text,password,apiKey) => engine.call("sparkRestoreBackup",{text,password,apiKey,...(network?{network}:{})}),
    sparkRefresh: () => engine.call("sparkRefresh",on),
    sparkUseForLightning: () => engine.call("sparkUseForLightning",on),
    preparePayment: (params) => engine.call("preparePayment",{...params,...(network?{network}:{})}),
    approvePayment: (id,confirmedReal) => engine.call("approvePayment",{id,...(confirmedReal?{confirmedReal:true as const}:{})}),
    reconcilePayment: (id) => engine.call("reconcilePayment",{id}),
    cancelPayment: (id) => engine.call("cancelPayment",{id}),

    testMintUrl: TEST_MINT,
    testMintUrls: TEST_MINTS,
    getState: () => {
      const state = engine.state?.wallet;
      if (!state || !network) return state ?? null;
      // One network's wallets, in the shape every panel reads; what the profile has and can make stays whole. Bound to
      // a Lightning card, `lightning` is that card's.
      const here = state.networks?.[network];
      const lightning = card ? here?.lightnings?.find((c) => c.card === card) ?? here?.lightning : here?.lightning;
      return { ...state, ...here, lightning, mode: network };
    },
    // The test mint is for trying things out right away, so it takes over as primary.
    addMint: async (url) => void (await engine.call("walletAddMint", { url, primary: TEST_MINTS.includes(url), ...on })),
    setPrimaryMint: (url) => engine.call("walletSetPrimaryMint", { url }),
    removeMint: (url, acceptLoss) => engine.call("walletRemoveMint", { url, ...(acceptLoss ? { acceptLoss } : {}) }),
    receiveLightning: (amount, via) => engine.call("walletReceiveLightning", { amount, via, ...ln }),
    quoteInvoice: (invoice, via) => engine.call("walletQuoteInvoice", { invoice, via, ...ln }),
    lightningSetSource: (providerId, values) => engine.call("lightningSetSource", { providerId, values, ...ln }),
    lightningClearSource: () => engine.call("lightningClearSource", ln),
    lightningRetrySource: () => engine.call("lightningRetrySource", ln),
    lightningReconfigureSource: (values) => engine.call("lightningReconfigureSource", { values, ...ln }),
    bitcoinSetSource: (providerId, values) => engine.call("bitcoinSetSource", { providerId, values, ...(network?{network}:{}) }),
    bitcoinClearSource: () => engine.call("bitcoinClearSource", on),
    bitcoinRetrySource: () => engine.call("bitcoinRetrySource", on),
    bitcoinReconfigureSource: (values) => engine.call("bitcoinReconfigureSource", { values, ...(network?{network}:{}) }),
    bitcoinReceiveAddress: () => engine.call("bitcoinReceiveAddress", on),
    bitcoinRefresh: () => engine.call("bitcoinRefresh", on),
    payQuote: async (quote, mint, note, confirmedReal) => (await engine.call("walletPayQuote", { quote, mint, note, ...(confirmedReal ? { confirmedReal: true as const } : {}) })).paid,
    resolveLightningAddress: (text) => engine.call("lnurlResolve", { text, ...(network?{network}:{}) }),
    lightningAddressInvoice: (id, amount, comment) => engine.call("lnurlInvoice", { id, amount, comment, ...(network?{network}:{}) }),
    async checkPayment(peerPubKeyZ32, paymentId) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      await engine.call("checkPayment", { linkId: link.id, paymentId });
    },
    receiveToken: async (token) => (await engine.call("walletReceiveToken", { token })).amount,
    inspectCashu: async (text) => (await engine.call("walletInspectCashu", { text })).inspection,
    exportTokens: () => engine.call("walletExport", on),
    backupReminder: (event) => engine.call("walletBackupReminder", event),
    async send(peerPubKeyZ32, amount, memo, confirmedReal) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const timestamp = Date.now();
      const { paymentId } = await engine.call("sendPayment", { linkId: link.id, amount, memo, timestamp, ...(network?{network}:{}), ...(confirmedReal ? { confirmedReal: true as const } : {}) });
      return { timestamp, paymentId };
    },
    async request(peerPubKeyZ32, amount, memo, method, rail) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const timestamp = Date.now();
      const { paymentId } = await engine.call("requestPayment", { linkId: link.id, amount, memo, timestamp, method, rail, ...ln });
      return { timestamp, paymentId };
    },
    async payRequest(peerPubKeyZ32, paymentId, options) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      const { confirmedReal, ...rest } = options ?? {};
      await engine.call("payRequest", { linkId: link.id, paymentId, ...rest, ...ln, ...(confirmedReal ? { confirmedReal: true as const } : {}) });
    },
    reclaim: (paymentId) => engine.call("reclaimPayment", { paymentId }),
    getPayment: (paymentId) => engine.state?.payments[paymentId] ?? null,
    async askToPay(peerPubKeyZ32, amount, method, memo) {
      const link = engine.linkByPeer(peerPubKeyZ32);
      if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
      return engine.call("askToPay", { linkId: link.id, amount, method, memo, timestamp: Date.now(), ...(network?{network}:{}) });
    },
    answerTo: (askId) => Object.values(engine.state?.payments ?? {}).find((p) => p.ask === askId && p.kind === "request" && p.direction === "in") ?? null,
  };
}

export const servicesPlatform: ServicesPlatform | null = {
  subscribe: (listener) => {
    preparingListeners.add(listener);
    const stop = engine.subscribe(listener);
    return () => { preparingListeners.delete(listener); stop(); };
  },

  isOnline: () => engine.state?.settings.online ?? false,
  setOnline: (online) => engine.call("updateSettings", { settings: { online } }),

  getSharedServices: () => engine.state?.services ?? [],

  async shareService(name, target) {
    const { origin } = parseLocalTarget(target);
    const url = new URL(origin);
    // Where the platform asks the user, it only does so from a user gesture: this has to come first.
    const granted = await getBrowserHost().requestLocalAccess(`${url.protocol}//${url.hostname}/*`, origin);
    if (!granted) throw new Error("Ghostly needs your permission to reach that local address");
    await engine.call("addService", { name, target });
  },
  async removeService(serviceId) {
    // Read before the call: the state after it may not have caught up yet.
    const services = engine.state?.services ?? [];
    const origin = originOf(services.find((s) => s.id === serviceId)?.target);
    await engine.call("removeService", { serviceId });
    // The last app at that address: the host may stop reaching it (desktop: Rust's list).
    if (origin && !services.some((s) => s.id !== serviceId && originOf(s.target) === origin)) {
      await getBrowserHost().forgetLocalAccess?.(origin).catch(() => {});
    }
  },
  setServiceEnabled: (serviceId, enabled) => engine.call("setServiceEnabled", { serviceId, enabled }),
  setServiceShared: (serviceId, peerPubKeyZ32, shared) => engine.call("setServiceShared", { serviceId, peerPubKeyZ32, shared }),

  getPeer(peerPubKeyZ32) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    return link ? { id: link.id, deliveryMode: link.deliveryMode, textDelivery: link.textDelivery, canSendText: link.canSendText, dhtDelivery: link.dhtDelivery, hold: link.hold, capabilities: link.capabilities, sessionOffers: link.sessionOffers, callsUnavailable: link.callsUnavailable, paymentMethods: link.paymentMethods, paymentNetworks: link.paymentNetworks, pairing: link.pairing, transportWait: link.transportWait, dataLink: link.dataLink, online: link.peerOnline, services: link.peerServices } : null;
  },
  async setChatPaymentMethods(peerPubKeyZ32, methods, networks) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
    await engine.call("setChatPaymentMethods", { linkId: link.id, methods, ...(networks ? { networks } : {}) });
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
  get fullscreenWindow() {
    const fullscreen = getBrowserHost().fullscreenWindow;
    return fullscreen ? (on: boolean) => fullscreen(on) : null;
  },
  shareText(text, anchor) {
    const share = getBrowserHost().shareText;
    return share ? share(text, anchor) : null;
  },
  readClipboardText() {
    const read = getBrowserHost().readClipboardText;
    return read ? read() : null;
  },
  readClipboardFiles() {
    const read = getBrowserHost().readClipboardFiles;
    return read ? read() : null;
  },
  callMedia: () => getBrowserHost().callMedia ?? null,
  get features() {
    return getBrowserHost().features;
  },
  get notice() {
    return getBrowserHost().notice;
  },

  maxFileBytes: LIMITS.maxFileBytes,

  fileTooLarge(peerPubKeyZ32, size) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    // files/3: the contact's device said how much it can take; otherwise it is asked when the file is offered.
    if (link?.capabilities?.largeFiles) {
      const room = link.peerFileRoom;
      return typeof room === "number" && size > room ? `Not enough space on your contact's device for this file (${formatFileSize(room)} free).` : null;
    }
    if (!link?.profile || link.capabilities?.files) {
      if (size <= LIMITS.maxFileBytes) return null;
      return link?.profile
        ? `That file is too large for your contact's app (max ${formatFileSize(LIMITS.maxFileBytes)}). Larger files need an updated Ghostly on their side.`
        : `That file is too large (max ${formatFileSize(LIMITS.maxFileBytes)}).`;
    }
    // Not live: whatever the contact takes is known when the file goes.
    return null;
  },

  async sendFile(peerPubKeyZ32, source, options) {
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (!link) throw new Error("Ghostly is still starting. Try again in a moment.");
    // Refused only by a live contact that takes no files: while not live, the peer keeps it and sends it when live.
    if (link.profile && !link.capabilities?.files && link.dataLink === "open") throw new Error("Connect to an updated peer to send files");
    const tooLarge = servicesPlatform!.fileTooLarge!(peerPubKeyZ32, source.size);
    if (tooLarge) throw new Error(tooLarge);

    const wireId = toBase64Url(randomBytes(12));
    // A reply (WISP 400 § Replies) goes with the file as it goes with a text: the engine keeps it and sends it along.
    const replyTo = options?.replyTo;
    // A picture goes with its size, read from its first bytes, so the contact's chat keeps its place while it loads.
    const image = options?.voice || options?.video ? undefined : await readImageMeta(source, sanitizeMime(source.type));
    const file = {
      // Its own key space: nothing a peer sends can land on this id.
      id: `${link.id}-out-${wireId}`,
      name: sanitizeFileName(source.name),
      size: source.size,
      mime: sanitizeMime(source.type),
      ...(options?.voice && { voice: parseVoiceMeta(options.voice, sanitizeMime(source.type)) }),
      // A description that does not check out is left off: the video still goes, without a poster.
      ...(!options?.voice && options?.video && { video: parseVideoMeta(options.video, sanitizeMime(source.type)) }),
      ...(image && { image }),
    };
    if (options?.voice && !file.voice) throw new Error("That recording cannot be sent as a voice message");
    // The page and the peer share this database and the file storage; the bytes never go through a message.
    // A small file is kept whole; a larger one is copied into file storage a step at a time.
    const timestamp = Date.now();
    const metadata = { name: file.name, size: file.size, mime: file.mime, timestamp, voice: file.voice, video: file.video, image: file.image };
    const transfer = { state: "transferring" as const, transferred: 0, size: file.size };
    if (source.size <= SMALL_FILE_BYTES) {
      // Its digest from the bytes in hand (a recording in memory): sending never has to read the stored copy back whole.
      const digest = await blobDigest(source);
      keepJustSent(file.id, new Blob([source], { type: file.mime }));
      await fileStore.put({ id: file.id, linkId: link.id, blob: source, digest, createdAt: timestamp, direction: "out", wireId, metadata, transfer });
      try {
        await engine.call("sendFile", { linkId: link.id, file, timestamp, ...(replyTo && { replyTo }) });
      } catch (error) {
        // Refused before it started (the contact's app takes no files, a stopped chat, offline): nothing is in the chat,
        // so the copy goes too, and the composer says why.
        justSent.delete(file.id);
        await fileStore.delete(file.id).catch(() => {});
        throw error;
      }
      return { timestamp, file };
    }
    // Copied first, which takes a while for a large file: the bubble shows the copy, then the transfer.
    preparing.set(file.id, { state: "transferring", stage: "preparing", transferred: 0, size: file.size });
    preparingChanged(true);
    let staged = false;
    void (async () => {
      const bytes = await fileBytes();
      const digest = await bytes.stage(file.id, source, (copied) => {
        preparing.set(file.id, { state: "transferring", stage: "preparing", transferred: copied, size: file.size });
        preparingChanged();
      });
      await fileStore.put({ id: file.id, linkId: link.id, bytes: bytes.kind, digest, createdAt: timestamp, direction: "out", wireId, metadata, transfer });
      // Copied: from here a refusal is the chat's, said as it is (its bubble keeps Retry), not a failed copy.
      staged = true;
      await engine.call("sendFile", { linkId: link.id, file, timestamp, ...(replyTo && { replyTo }) });
      preparing.delete(file.id);
      preparingChanged(true);
    })().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      const full = /quota|space|full/i.test(reason) || (error as { name?: string })?.name === "QuotaExceededError";
      preparing.set(file.id, { state: "failed", transferred: 0, size: file.size, error: staged ? reason : full ? "Not enough space on this device to send it" : `Could not prepare the file: ${reason}` });
      preparingChanged(true);
    });
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
    // A deleted file is not shown again from memory either.
    justSent.clear();
    const link = engine.linkByPeer(peerPubKeyZ32);
    if (link) await engine.call("deleteMessage", { linkId: link.id, messageId });
  },
  getTransfer: (fileId) => preparing.get(fileId) ?? engine.state?.transfers[fileId] ?? null,
  transfersRestored: () => engine.state?.transfersRestored ?? false,
  async fileAction(fileId, action) {
    // A file's local id starts with its chat's.
    const linkId = engine.state?.links.find((link) => fileId.startsWith(`${link.id}-in-`) || fileId.startsWith(`${link.id}-out-`))?.id
      ?? (await fileStore.get(fileId).catch(() => undefined))?.linkId;
    if (!linkId) throw new Error("This file is no longer here");
    await engine.call("fileAction", { linkId, fileId, action });
  },
  async getFile(fileId) {
    const held = justSent.get(fileId);
    if (held) return held.slice(0, held.size, safeBlobType(held.type));
    const stored = await fileStore.get(fileId);
    if (!stored) return null;
    // Files stored before received types were cleaned up may still carry the peer's type.
    return storedBlob(stored, safeBlobType(stored.blob?.type || stored.metadata?.mime || ""));
  },
  async fileHeld(fileId) {
    if (justSent.has(fileId)) return "here";
    const stored = await fileStore.get(fileId);
    if (!stored) return "gone";
    if (stored.leftOut) return "left-out";
    if (stored.blob) return "here";
    const bytes = stored.bytes && await fileBytesOf(stored.bytes);
    return bytes && (await bytes.size(fileId).catch(() => null)) !== null ? "here" : "gone";
  },
  async streamFile(fileId) {
    const stored = await fileStore.get(fileId);
    const bytes = stored?.bytes && await fileBytesOf(stored.bytes);
    if (!stored || !bytes?.stream) return null;
    return bytes.stream(fileId, safeBlobType(stored.metadata?.mime || ""));
  },
  async saveFile(fileId, name) {
    const stored = await fileStore.get(fileId);
    const saveAs = name ?? stored?.metadata?.name;
    if (!stored || !saveAs) return null;
    const bytes = stored.bytes && await fileBytesOf(stored.bytes);
    if (bytes?.save) return bytes.save(fileId, saveAs);
    // A small file (a voice message, most pictures) is kept as a Blob, saved like any bytes made here.
    return stored.blob ? saveStaged(stored.blob, saveAs) : null;
  },
  saveBlob: (blob, name) => saveStaged(blob, name),

  wallet: walletPlatform(),

  getNetwork() {
    const state = engine.state;
    if (!state) return null;
    return {
      protocol: state.transport.protocol,
      relays: state.settings.relays,
      defaultRelays: DEFAULT_RELAYS,
      turn: state.settings.iceServers[0] ?? null,
      ...(state.transport.iroh ? { iroh: { relays: state.settings.irohRelays ?? [], defaultRelays: state.transport.iroh.defaults } } : {}),
      hyperdhtRelay: state.settings.hyperdhtRelay ?? DEFAULT_HYPERDHT_RELAY,
      pushRelay: state.settings.pushRelay ?? "",
      ...(state.transport.direct ? { readRelays: state.settings.readRelays === true } : {}),
      ...(state.transport.directBlocked ? { directBlocked: true } : {}),
      ...(state.transport.clockOffMs !== undefined ? { clockOffMs: state.transport.clockOffMs } : {}),
    };
  },
  setNetwork: ({ relays, turn, irohRelays, hyperdhtRelay, readRelays, pushRelay }) =>
    engine.call("updateSettings", { settings: { relays, iceServers: turn?.urls ? [turn] : [], ...(irohRelays ? { irohRelays } : {}), ...(hyperdhtRelay !== undefined ? { hyperdhtRelay } : {}), ...(readRelays !== undefined ? { readRelays } : {}), ...(pushRelay !== undefined ? { pushRelay } : {}) } }),
};
