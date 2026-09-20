import {
  DEFAULT_RELAYS,
  GhostLink,
  GhostlyHttpError,
  HTTP_SERVICE_PROTO,
  LEGACY_SERVICES,
  LIMITS,
  RELAY_POLL_INTERVALS,
  RTC_CONFIG,
  RelayTransport,
  createLink,
  decodeInviteCode,
  encodeInviteCode,
  formatLocalTarget,
  identityFromSeedB64,
  parseLocalTarget,
  randomBytes,
  safeBlobType,
  serviceIdFromName,
  toBase64Url,
  webLocalFetch,
  type ClientRequest,
  type ClientResponse,
  type DataLinkState,
  type FileSink,
  type HostedHttpService,
  type LinkParams,
  type LinkStatus,
  type LocalFetch,
  type PkarrTransport,
  type PollIntervals,
  type PeerPresence,
  type ServiceAd,
} from "@ghostly/core";
import type { EngineImplementation } from "../shared/rpc";
import { fileStore, type StoredFile } from "../shared/idb";
import { DEFAULT_MINTS, TEST_MINT } from "../shared/mints";
import type {
  EngineState,
  FileTransferView,
  LinkView,
  MessageFile,
  Settings,
  StoredLink,
  StoredMessage,
  StoredService,
  WalletView,
} from "../shared/types";
import { db } from "./db";
import { PaymentDesk } from "./payments";
import { CashuWallet } from "./wallet";

const DEFAULT_SETTINGS: Settings = {
  online: true,
  nick: "",
  relays: DEFAULT_RELAYS,
  iceServers: [],
  mints: [],
  mintsInitialized: false,
};

/** How many deleted ids a link remembers: enough to outlast what a peer republishes. */
const MAX_DELETED_IDS = 500;

interface LiveLink {
  stored: StoredLink;
  myPubKeyZ32: string;
  link: GhostLink | null;
  status: LinkStatus;
  dataLink: DataLinkState;
  presence: PeerPresence;
  lastMessageAt: number;
  peerAck: number;
  lastSyncAt: number;
  poll: LinkView["poll"];
  files: LinkFiles;
}

/** What one peer has sent us, so it can neither fill the disk nor reuse an id. */
interface LinkFiles {
  /** Received bytes stored, plus those announced by transfers still in flight. */
  receivedBytes: number;
  /** Wire ids already used on this link, in either direction. */
  wireIds: Set<string>;
  /** Transfers in flight from the peer, by wire id. */
  incoming: Map<string, { localId: string; size: number }>;
}

function emptyLinkFiles(): LinkFiles {
  return { receivedBytes: 0, wireIds: new Set(), incoming: new Map() };
}

/** Rebuilds the per-link file bookkeeping from what is stored. */
function linkFilesFrom(linkId: string, files: StoredFile[], messages: StoredMessage[]): LinkFiles {
  const result = emptyLinkFiles();
  // Files stored before ids had a direction: the chat message says who sent them.
  const fromPeer = new Set(messages.flatMap((m) => (m.sender === "peer" && m.file ? [m.file.id] : [])));
  for (const file of files) {
    const legacy = !file.direction;
    result.wireIds.add(file.wireId ?? file.id.slice(linkId.length + 1));
    if (file.direction === "in" || (legacy && fromPeer.has(file.id))) result.receivedBytes += file.blob.size;
  }
  return result;
}

function newLiveLink(stored: StoredLink, lastMessageAt: number, files = emptyLinkFiles()): LiveLink {
  return {
    stored,
    myPubKeyZ32: identityFromSeedB64(stored.seedB64).pubKeyZ32,
    link: null,
    status: "offline",
    dataLink: "idle",
    presence: { online: false, lastPacketAt: 0, services: null },
    lastMessageAt,
    peerAck: 0,
    lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 },
    files,
  };
}

/** What a host may replace. The defaults are what a browser can do on its own. */
export interface NodeOptions {
  /** How to reach Pkarr. Default: HTTP relays, the only way out of a browser. */
  transport?: PkarrTransport;
  pollIntervals?: PollIntervals;
  /** How to reach a shared local web app. Default: `fetch`, which needs the app's or the browser's consent. */
  localFetch?: LocalFetch;
}

export interface NodeEvents {
  onState(state: EngineState): void;
  onMessages(linkId: string, messages: StoredMessage[]): void;
  onCallSignal(linkId: string, signal: string): void;
}

/**
 * The Ghostly peer running in this browser: every link, the services it
 * shares, and the glue to IndexedDB. It owns nothing durable on the network;
 * when it stops, the peer is gone.
 */
export class GhostlyNode implements EngineImplementation {
  private settings: Settings = DEFAULT_SETTINGS;
  private readonly transport: PkarrTransport;
  private readonly relays: RelayTransport | null;
  private readonly pollIntervals: PollIntervals;
  private readonly localFetch: LocalFetch;
  private readonly links = new Map<string, LiveLink>();
  private services: StoredService[] = [];
  private readonly requestCounts = new Map<string, number>();
  private readonly transfers = new Map<string, FileTransferView>();
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private walletView: WalletView = { mints: [], balance: 0, history: [], feesPaid: 0 };

  private readonly wallet = new CashuWallet(() => this.settings.mints, {
    onChange: () => void this.refreshWallet(),
    onQuotePaid: (quote) => void this.desk.onQuotePaid(quote),
    onMeltResolved: (melt, paid) => void this.desk.onMeltResolved(melt, paid),
    onTestMintNeeded: async () => void (await this.walletAddMint({ url: TEST_MINT })),
  });
  private readonly desk = new PaymentDesk(this.wallet, {
    getLink: (linkId) => this.links.get(linkId)?.link ?? null,
    storeMessage: (message) => this.storeMessage(message),
    onChange: () => this.emitState(),
  });

  constructor(
    private readonly events: NodeEvents,
    options: NodeOptions = {},
  ) {
    // Relays are a setting only where relays are the transport.
    this.relays = options.transport ? null : new RelayTransport();
    this.transport = options.transport ?? this.relays!;
    this.pollIntervals = options.pollIntervals ?? RELAY_POLL_INTERVALS;
    this.localFetch = options.localFetch ?? webLocalFetch;
  }

  private async refreshWallet(): Promise<void> {
    this.walletView = await this.wallet.view();
    this.emitState();
  }

  async start(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await db.getSettings()) };
    if (!this.settings.mintsInitialized) {
      this.settings = { ...this.settings, mints: [...new Set([...this.settings.mints, ...DEFAULT_MINTS])], mintsInitialized: true };
      await db.putSettings(this.settings);
    }
    this.relays?.setRelays(this.settings.relays);
    this.services = await db.getServices();
    await this.desk.start();
    await this.refreshWallet();
    this.wallet.start();

    for (const stored of await db.getLinks()) {
      const messages = await db.getMessages(stored.id);
      const files = linkFilesFrom(stored.id, await fileStore.listForLink(stored.id), messages);
      this.links.set(stored.id, newLiveLink(stored, messages[messages.length - 1]?.timestamp ?? 0, files));
      if (this.settings.online) this.startLink(stored.id, messages);
    }
    this.emitState();
  }

  /** Tells every peer we are leaving. Best effort: the browser may already be closing. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.links.values()].map((live) => live.link?.stop(true)));
  }

  getState(): EngineState {
    return {
      settings: this.settings,
      transport: this.transport.describe(),
      links: [...this.links.values()].map((live) => this.viewOf(live)).sort((a, b) => b.createdAt - a.createdAt),
      services: this.services
        .map((s) => ({ ...s, requests: this.requestCounts.get(s.id) ?? 0 }))
        .sort((a, b) => a.createdAt - b.createdAt),
      transfers: Object.fromEntries(this.transfers),
      wallet: this.walletView,
      payments: this.desk.views(),
    };
  }

  getMessages(linkId: string): Promise<StoredMessage[]> {
    return db.getMessages(linkId);
  }

  // -- links ---------------------------------------------------------------

  createLink(): { linkId: string; inviteCode: string } {
    const { mine, invite } = createLink();
    const inviteCode = encodeInviteCode(invite);
    return { linkId: this.addLink(mine, inviteCode), inviteCode };
  }

  joinLink({ inviteCode }: { inviteCode: string }): { linkId: string } {
    const params = decodeInviteCode(inviteCode);
    if (!params) throw new Error("That does not look like a Ghostly invite");
    const existing = [...this.links.values()].find((l) => l.stored.seedB64 === params.seedB64);
    if (existing) return { linkId: existing.stored.id };
    return { linkId: this.addLink(params) };
  }

  ensureLink(params: LinkParams): { linkId: string } {
    return this.joinLink({ inviteCode: encodeInviteCode(params) });
  }

  pollNow({ linkId }: { linkId: string }): void {
    this.links.get(linkId)?.link?.session.pollNow();
  }

  removeLink({ linkId }: { linkId: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    void live.link?.stop(true);
    this.links.delete(linkId);
    void db.deleteLink(linkId);
    void this.desk.forgetLink(linkId);
    this.emitState();
  }

  renameLink({ linkId, label }: { linkId: string; label: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    live.stored = { ...live.stored, label: label.trim().slice(0, 48) || undefined };
    void db.putLink(live.stored);
    this.emitState();
  }

  setActiveLink({ linkId }: { linkId: string | null }): void {
    for (const [id, live] of this.links) live.link?.session.setActive(id === linkId);
  }

  exportLinks() {
    return [...this.links.values()].map(({ stored }) => ({
      seedB64: stored.seedB64,
      peerPubKeyZ32: stored.peerPubKeyZ32,
      encKeyB64: stored.encKeyB64,
      createdAt: stored.createdAt,
      inviteCode: stored.inviteCode,
      label: stored.label,
    }));
  }

  async sendMessage(params: { linkId: string; text: string; timestamp?: number }): Promise<{ error: string | null }> {
    const { linkId, text } = params;
    const live = this.links.get(linkId);
    if (!live?.link) return { error: "You are offline" };
    const trimmed = text.trim();
    if (!trimmed) return { error: null };

    const timestamp = params.timestamp ?? Date.now();
    const via = live.link.isDataLinkOpen ? "datalink" : "pkarr";
    await this.storeMessage({ linkId, id: `me_${timestamp}`, text: trimmed, sender: "me", timestamp, via });
    const error = await live.link.sendMessage(trimmed, timestamp);
    // The data link is reliable and ordered: sent means delivered.
    if (!error && via === "datalink" && timestamp > live.peerAck) {
      live.peerAck = timestamp;
      this.emitState();
    }
    return { error };
  }

  /**
   * Forgets one message here: its row, the bytes of the file it carried, and
   * its id, so the peer republishing it does not bring it back. Nothing goes
   * out on the wire — the peer keeps its own copy.
   */
  deleteMessage({ linkId, messageId }: { linkId: string; messageId: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    live.stored = {
      ...live.stored,
      deletedIds: [...(live.stored.deletedIds ?? []), messageId].slice(-MAX_DELETED_IDS),
    };
    void db.putLink(live.stored);

    void (async () => {
      const message = (await db.getMessages(linkId)).find((m) => m.id === messageId);
      if (message?.file) {
        const stored = await fileStore.get(message.file.id);
        // Only what the peer sent counts against the room it has here.
        if (stored && (stored.direction === "in" || (!stored.direction && message.sender === "peer"))) {
          live.files.receivedBytes = Math.max(0, live.files.receivedBytes - stored.blob.size);
        }
        await fileStore.delete(message.file.id);
        this.transfers.delete(message.file.id);
      }
      await db.deleteMessage(linkId, messageId);
      const messages = await db.getMessages(linkId);
      live.lastMessageAt = messages[messages.length - 1]?.timestamp ?? 0;
      this.events.onMessages(linkId, messages);
      this.emitState();
    })();
  }

  /** Local id of a file we send: the id on the wire is ours too, but lives in its own key space. */
  private static outgoingFileId(linkId: string, wireId: string): string {
    return `${linkId}-out-${wireId}`;
  }

  sendFile({ linkId, file, timestamp }: { linkId: string; file: MessageFile; timestamp: number }): void {
    const live = this.links.get(linkId);
    const fail = (error: string) => {
      this.transfers.set(file.id, { state: "failed", transferred: 0, size: file.size, error });
      this.emitState();
    };
    if (!live?.link) return fail("You are offline");
    const wireId = file.id.slice(`${linkId}-out-`.length);
    if (file.id !== GhostlyNode.outgoingFileId(linkId, wireId)) return fail("Invalid file id");
    const { link } = live;
    live.files.wireIds.add(wireId);

    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    void this.storeMessage({
      linkId,
      id: `me_${timestamp}`,
      text: `📎 ${file.name}`,
      sender: "me",
      timestamp,
      via: "datalink",
      file,
    });

    void (async () => {
      const stored = await fileStore.get(file.id);
      if (!stored) return fail("The file is gone");
      const reader = stored.blob.stream().getReader();
      const source = (async function* () {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      })();
      await link.sendFile(
        { id: wireId, name: file.name, size: file.size, mime: file.mime, timestamp },
        source,
      );
    })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
  }

  private receiveFile(
    linkId: string,
    wire: { id: string; name: string; size: number; mime: string; timestamp: number },
  ): FileSink | string {
    const files = this.links.get(linkId)?.files;
    if (!files) return "refused";
    // A known id could only be a replay or an attempt to pass for a file we already have.
    if (files.wireIds.has(wire.id)) return "duplicate file id";
    if (files.receivedBytes + wire.size > LIMITS.maxStoredIncomingBytesPerPeer) return "no room for more files";

    // The local id is ours, never the peer's: whatever it announces cannot replace a stored file.
    const file: MessageFile = { ...wire, id: `${linkId}-in-${toBase64Url(randomBytes(12))}` };
    files.wireIds.add(wire.id);
    files.receivedBytes += wire.size;
    files.incoming.set(wire.id, { localId: file.id, size: wire.size });
    const chunks: Uint8Array[] = [];
    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    void this.storeMessage({
      linkId,
      id: `peer_${wire.timestamp}`,
      text: `📎 ${file.name}`,
      sender: "peer",
      timestamp: wire.timestamp,
      via: "datalink",
      file: { id: file.id, name: file.name, size: file.size, mime: file.mime },
    });
    return {
      write: (chunk) => void chunks.push(chunk),
      // The message keeps the announced type for display; the bytes are served as something inert.
      close: () => {
        const live = this.links.get(linkId);
        // Deleted while it was still arriving: the bytes have nowhere to land, and give their room back.
        if (live?.stored.deletedIds?.includes(`peer_${wire.timestamp}`)) {
          live.files.receivedBytes = Math.max(0, live.files.receivedBytes - wire.size);
          return;
        }
        return fileStore.put({
          id: file.id,
          linkId,
          blob: new Blob(chunks as BlobPart[], { type: safeBlobType(file.mime) }),
          createdAt: Date.now(),
          direction: "in",
          wireId: wire.id,
        });
      },
      abort: () => void (chunks.length = 0),
    };
  }

  /** Maps a wire id from the data link to the local id; an incoming file that ended is settled here. */
  private localFileId(linkId: string, wireId: string, direction: "in" | "out", settled?: { failed: boolean }): string | undefined {
    if (direction === "out") return GhostlyNode.outgoingFileId(linkId, wireId);
    const files = this.links.get(linkId)?.files;
    const entry = files?.incoming.get(wireId);
    if (!files || !entry) return undefined;
    if (settled) {
      files.incoming.delete(wireId);
      // Only what was not kept gives its room back.
      if (settled.failed) files.receivedBytes -= entry.size;
    }
    return entry.localId;
  }

  private fileProgress(fileId: string | undefined, transferred: number): void {
    if (!fileId) return;
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.state !== "transferring") return;
    transfer.transferred = transferred;
    this.emitState(250);
  }

  private fileSettled(fileId: string | undefined, error?: string): void {
    if (!fileId) return;
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    this.transfers.set(fileId, error ? { ...transfer, state: "failed", error } : { ...transfer, state: "done", transferred: transfer.size });
    this.emitState();
  }

  connect({ linkId }: { linkId: string }): void {
    this.links.get(linkId)?.link?.connect().catch(() => {});
  }

  disconnect({ linkId }: { linkId: string }): void {
    this.links.get(linkId)?.link?.disconnect();
  }

  setCallSignal({ linkId, signal }: { linkId: string; signal: string | null }): void {
    void this.links.get(linkId)?.link?.setCallSignal(signal);
  }

  setFastPoll({ linkId, fast }: { linkId: string; fast: boolean }): void {
    this.links.get(linkId)?.link?.session.setFastPoll(fast);
  }

  /** Used by the viewer: a request to a service some peer shares with us. */
  async request(peerPubKeyZ32: string, serviceId: string, request: ClientRequest): Promise<ClientResponse> {
    const live = [...this.links.values()].find((l) => l.stored.peerPubKeyZ32 === peerPubKeyZ32);
    if (!live) throw new GhostlyHttpError("unknown-peer", "You have no link to this peer");
    if (!live.link) throw new GhostlyHttpError("offline", "Ghostly is offline");
    return live.link.request(serviceId, request);
  }

  // -- wallet and payments --------------------------------------------------

  async walletAddMint({ url, primary }: { url: string; primary?: boolean }): Promise<{ url: string; name: string }> {
    const mint = await this.wallet.checkMint(url);
    const others = this.settings.mints.filter((m) => m !== mint.url);
    const known = others.length !== this.settings.mints.length;
    if (primary) await this.updateSettings({ settings: { mints: [mint.url, ...others] } });
    else if (!known) await this.updateSettings({ settings: { mints: [...others, mint.url] } });
    await this.refreshWallet();
    return mint;
  }

  async walletSetPrimaryMint({ url }: { url: string }): Promise<void> {
    if (!this.settings.mints.includes(url)) return;
    await this.updateSettings({ settings: { mints: [url, ...this.settings.mints.filter((m) => m !== url)] } });
    await this.refreshWallet();
  }

  async walletRemoveMint({ url }: { url: string }): Promise<void> {
    if ((await this.wallet.balanceAt(url)) > 0) throw new Error("Move your sats out of this mint before removing it");
    await this.updateSettings({ settings: { mints: this.settings.mints.filter((m) => m !== url) } });
    await this.refreshWallet();
  }

  async walletReceiveLightning({ amount }: { amount: number }) {
    const quote = await this.wallet.receiveLightning(amount);
    return { quote: quote.quote, invoice: quote.invoice, expiresAt: quote.expiresAt };
  }

  walletQuoteInvoice({ invoice }: { invoice: string }) {
    return this.wallet.quoteInvoice(invoice);
  }

  async walletPayQuote({ quote, mint }: { quote: string; mint: string }) {
    return { paid: await this.wallet.payQuote(quote, mint) };
  }

  walletInspectCashu({ text }: { text: string }) {
    return { inspection: this.wallet.inspect(text) };
  }

  async walletReceiveToken({ token }: { token: string }) {
    const { amount } = await this.wallet.receiveToken(token.trim());
    return { amount };
  }

  walletExport() {
    return this.wallet.exportTokens();
  }

  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number }) {
    return this.desk.send(params);
  }

  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number }) {
    return this.desk.request(params);
  }

  payRequest(params: { linkId: string; paymentId: string }) {
    return this.desk.payRequest(params);
  }

  reclaimPayment({ paymentId }: { paymentId: string }) {
    return this.desk.reclaim(paymentId);
  }

  // -- services ------------------------------------------------------------

  addService({ name, target }: { name: string; target: string }): { serviceId: string } {
    const cleanName = name.trim().slice(0, 48);
    if (!cleanName) throw new Error("Give the service a name");
    const normalized = formatLocalTarget(parseLocalTarget(target));
    const service: StoredService = {
      id: serviceIdFromName(
        cleanName,
        this.services.map((s) => s.id),
      ),
      name: cleanName,
      target: normalized,
      enabled: true,
      createdAt: Date.now(),
    };
    this.services.push(service);
    void db.putService(service);
    this.servicesChanged();
    return { serviceId: service.id };
  }

  removeService({ serviceId }: { serviceId: string }): void {
    this.services = this.services.filter((s) => s.id !== serviceId);
    void db.deleteService(serviceId);
    this.servicesChanged();
  }

  setServiceEnabled({ serviceId, enabled }: { serviceId: string; enabled: boolean }): void {
    const service = this.services.find((s) => s.id === serviceId);
    if (!service || service.enabled === enabled) return;
    service.enabled = enabled;
    void db.putService(service);
    this.servicesChanged();
  }

  // -- settings ------------------------------------------------------------

  async updateSettings({ settings }: { settings: Partial<Settings> }): Promise<void> {
    const wasOnline = this.settings.online;
    this.settings = { ...this.settings, ...settings };
    if (settings.relays) {
      this.relays?.setRelays(settings.relays);
      if (this.relays) this.settings.relays = this.relays.describe().relays;
    }
    await db.putSettings(this.settings);

    if (settings.nick !== undefined) {
      for (const live of this.links.values()) live.link?.session.setNick(this.settings.nick || undefined);
    }
    if (wasOnline && !this.settings.online) {
      await Promise.allSettled(
        [...this.links.values()].map(async (live) => {
          await live.link?.stop(true);
          live.link = null;
          live.status = "offline";
          live.dataLink = "idle";
        }),
      );
    } else if (!wasOnline && this.settings.online) {
      for (const live of this.links.values()) this.startLink(live.stored.id, await db.getMessages(live.stored.id));
    }
    this.emitState();
  }

  // -- internals -----------------------------------------------------------

  private addLink(params: LinkParams, inviteCode?: string): string {
    const stored: StoredLink = {
      id: identityFromSeedB64(params.seedB64).pubKeyZ32.slice(0, 16),
      ...params,
      createdAt: Date.now(),
      inviteCode,
    };
    this.links.set(stored.id, newLiveLink(stored, 0));
    void db.putLink(stored);
    if (this.settings.online) this.startLink(stored.id, []);
    this.emitState();
    return stored.id;
  }

  /** What this peer advertises. Chat, voice and video are what Ghostly always offered. */
  private advertisedServices(): ServiceAd[] {
    return [
      ...LEGACY_SERVICES,
      ...this.services
        .filter((s) => s.enabled)
        .map((s): ServiceAd => ({ id: s.id, type: "http", name: s.name, proto: HTTP_SERVICE_PROTO })),
    ];
  }

  /** The only place a service id turns into a URL. Disabled or unknown ids do not resolve. */
  private hostedService(id: string): HostedHttpService | undefined {
    const service = this.services.find((s) => s.id === id && s.enabled);
    if (!service) return undefined;
    try {
      const target = parseLocalTarget(service.target);
      this.requestCounts.set(id, (this.requestCounts.get(id) ?? 0) + 1);
      this.emitState();
      return { id, target };
    } catch {
      return undefined;
    }
  }

  private startLink(linkId: string, messages: StoredMessage[]): void {
    const live = this.links.get(linkId);
    if (!live || live.link) return;
    const { stored } = live;
    const lastSeenTimestamp = messages.reduce(
      (max, m) => (m.sender === "peer" && m.via === "pkarr" ? Math.max(max, m.timestamp) : max),
      0,
    );

    live.link = new GhostLink({
      params: stored,
      transport: this.transport,
      nick: this.settings.nick || undefined,
      lastSeenTimestamp,
      pollIntervals: this.pollIntervals,
      autoConnect: true,
      createPeerConnection: () =>
        new RTCPeerConnection({ iceServers: [...(RTC_CONFIG.iceServers ?? []), ...this.settings.iceServers] }),
      localFetch: this.localFetch,
      getServices: () => this.advertisedServices(),
      getHostedHttpService: (id) => this.hostedService(id),
      events: {
        onStatus: (status) => {
          live.status = status;
          if (status === "online") live.lastSyncAt = Date.now();
          this.emitState();
        },
        onPoll: ({ polling, nextInMs }) => {
          live.poll = { polling, nextAt: Date.now() + nextInMs, interval: nextInMs || live.poll.interval };
          this.emitState();
        },
        onPeerAck: (ack) => {
          if (ack === live.peerAck) return;
          live.peerAck = ack;
          this.emitState();
        },
        onDataLinkState: (state) => {
          live.dataLink = state;
          this.emitState();
        },
        onPresence: (presence) => {
          live.presence = presence;
          if (presence.nick && presence.nick !== live.stored.peerNick) {
            live.stored = { ...live.stored, peerNick: presence.nick };
            void db.putLink(live.stored);
          }
          this.emitState();
        },
        onMessage: (message) => {
          if (live.stored.inviteCode) {
            live.stored = { ...live.stored, inviteCode: undefined };
            void db.putLink(live.stored);
          }
          void this.storeMessage({
            linkId,
            id: `peer_${message.timestamp}`,
            text: message.text,
            sender: "peer",
            timestamp: message.timestamp,
            via: message.via,
            nick: message.nick,
          });
        },
        onCallSignal: (signal) => this.events.onCallSignal(linkId, signal),
        onPaymentRequest: (request) => void this.desk.onPaymentRequest(linkId, request),
        onPayment: (payment) => void this.desk.onPayment(linkId, payment),
        onPaymentResult: (result) => void this.desk.onPaymentResult(linkId, result),
        onFileIncoming: (file) => this.receiveFile(linkId, file),
        onFileProgress: (id, transferred, direction) =>
          this.fileProgress(this.localFileId(linkId, id, direction), transferred),
        onFileComplete: (id, direction) =>
          this.fileSettled(this.localFileId(linkId, id, direction, { failed: false })),
        onFileFailed: (id, reason, direction) =>
          this.fileSettled(this.localFileId(linkId, id, direction, { failed: true }), reason),
      },
    });
    live.link.start();
  }

  private async storeMessage(message: StoredMessage): Promise<void> {
    const live = this.links.get(message.linkId);
    // The peer republishes what it sent for a few minutes: what was deleted here stays deleted.
    if (live?.stored.deletedIds?.includes(message.id)) return;
    if (!(await db.addMessage(message))) return;
    if (live) live.lastMessageAt = Math.max(live.lastMessageAt, message.timestamp);
    this.events.onMessages(message.linkId, await db.getMessages(message.linkId));
    this.emitState();
  }

  private servicesChanged(): void {
    for (const live of this.links.values()) void live.link?.refreshServices();
    this.emitState();
  }

  private viewOf(live: LiveLink): LinkView {
    const { stored, presence } = live;
    return {
      id: stored.id,
      myPubKeyZ32: live.myPubKeyZ32,
      peerPubKeyZ32: stored.peerPubKeyZ32,
      label: stored.label,
      peerNick: stored.peerNick,
      inviteCode: stored.inviteCode,
      createdAt: stored.createdAt,
      status: live.status,
      dataLink: live.dataLink,
      peerOnline: presence.online,
      peerLastSeenAt: presence.lastPacketAt,
      peerServices: presence.services,
      lastMessageAt: live.lastMessageAt,
      peerAck: live.peerAck,
      lastSyncAt: live.lastSyncAt,
      poll: live.poll,
    };
  }

  /** State changes arrive in bursts; the UI gets one snapshot per tick. */
  private emitState(delayMs = 50): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.events.onState(this.getState());
    }, delayMs);
  }
}
