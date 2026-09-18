import { DataLink, type DataLinkState } from "./datalink";
import {
  CHUNK_KIND,
  LIMITS,
  PROTOCOL_VERSION,
  decodeChunk,
  decodeControl,
  encodeControl,
  type FrameChannel,
} from "./frames";
import { FileTransfers, type FileInfo, type FileSink } from "./files";
import {
  HttpClient,
  HttpHost,
  GhostlyHttpError,
  type ClientRequest,
  type ClientResponse,
  type HostedHttpService,
  type LocalFetch,
} from "./http";
import type { LinkParams } from "./invite";
import { LinkSession, type LinkStatus, type PeerPresence, type PollIntervals } from "./link";
import type { ResolvedLink } from "./records";
import { servicesFromWire, servicesToWire, type ServiceAd } from "./services";
import type { PkarrTransport } from "./transport";

/**
 * One link to one peer, complete: Pkarr presence and signaling, the WebRTC
 * data link, and the services multiplexed on top of it. Platform specifics
 * (how to reach Pkarr, how to create a peer connection, how to reach a local
 * HTTP server) are injected, so Desktop and Browser run the same code.
 */
const AUTO_CONNECT_RETRY_MS = 90_000;

export interface IncomingMessage {
  text: string;
  timestamp: number;
  nick?: string;
  via: "pkarr" | "datalink";
  batch?: ResolvedLink;
}

export interface GhostLinkEvents {
  onMessage?(message: IncomingMessage): void;
  onPresence?(presence: PeerPresence): void;
  onPeerAck?(ackTimestamp: number): void;
  onCallSignal?(signal: string): void;
  onStatus?(status: LinkStatus): void;
  onDataLinkState?(state: DataLinkState): void;
  onPoll?(poll: { polling: boolean; nextInMs: number }): void;
  /** The peer is sending a file. Return where to put it, or null to refuse. */
  onFileIncoming?(file: FileInfo): FileSink | null;
  onFileProgress?(fileId: string, transferred: number, direction: "in" | "out"): void;
  onFileComplete?(fileId: string, direction: "in" | "out"): void;
  onFileFailed?(fileId: string, reason: string, direction: "in" | "out"): void;
}

export interface GhostLinkOptions {
  params: LinkParams;
  transport: PkarrTransport;
  nick?: string;
  lastSeenTimestamp?: number;
  pollIntervals?: PollIntervals;
  /**
   * Open the data link on its own whenever the peer is online, instead of on
   * first use. Chat and call signaling then travel peer to peer and Pkarr is
   * only polled once a minute, which is what keeps relays happy.
   */
  autoConnect?: boolean;
  createPeerConnection: () => RTCPeerConnection;
  localFetch: LocalFetch;
  /** Everything this peer currently offers on this link. */
  getServices: () => ServiceAd[] | undefined;
  /** Resolves an advertised `http` service id to its local target. */
  getHostedHttpService: (id: string) => HostedHttpService | undefined;
  events?: GhostLinkEvents;
}

export class GhostLink {
  readonly session: LinkSession;
  readonly dataLink: DataLink;
  private readonly options: GhostLinkOptions;
  private channel: FrameChannel | null = null;
  private httpHost: HttpHost | null = null;
  private httpClient: HttpClient | null = null;
  private files: FileTransfers | null = null;
  private peerServicesOverride: ServiceAd[] | null = null;
  private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private lastAutoConnectAt = 0;

  constructor(options: GhostLinkOptions) {
    this.options = options;
    const events = options.events ?? {};

    this.session = new LinkSession({
      params: options.params,
      transport: options.transport,
      nick: options.nick,
      lastSeenTimestamp: options.lastSeenTimestamp,
      pollIntervals: options.pollIntervals,
      getServices: options.getServices,
      events: {
        onMessages: (messages, batch) => {
          for (const m of messages) events.onMessage?.({ ...m, via: "pkarr", batch });
        },
        onPresence: (presence) => {
          events.onPresence?.(this.mergePresence(presence));
          this.maybeAutoConnect(presence);
        },
        onPeerAck: (ack) => events.onPeerAck?.(ack),
        onCallSignal: (signal) => events.onCallSignal?.(signal),
        onRtcSignal: (signal) => void this.dataLink.handleSignal(signal),
        onStatus: (status) => events.onStatus?.(status),
        onPoll: (poll) => events.onPoll?.(poll),
      },
    });

    this.dataLink = new DataLink({
      myPubKeyZ32: this.session.identity.pubKeyZ32,
      peerPubKeyZ32: options.params.peerPubKeyZ32,
      createPeerConnection: options.createPeerConnection,
      publishSignal: (signal) => void this.session.setRtcSignal(signal),
      setFastPoll: (fast) => this.session.setFastPoll(fast),
      onOpen: (channel) => this.attach(channel),
      onClose: () => this.detach(),
      onState: (state) => {
        events.onDataLinkState?.(state);
        if (state === "idle") this.rejectWaiters(new GhostlyHttpError("unreachable", "Could not connect to the peer"));
      },
    });
  }

  get myPubKeyZ32(): string {
    return this.session.identity.pubKeyZ32;
  }

  get isDataLinkOpen(): boolean {
    return this.channel !== null;
  }

  get presence(): PeerPresence {
    return this.mergePresence(this.session.peerPresence);
  }

  start(): void {
    this.session.start();
  }

  async stop(announce = true): Promise<void> {
    this.dataLink.close();
    await this.session.stop(announce);
  }

  /** Opens the data link if needed and resolves once it is usable. */
  connect(timeoutMs = 90_000): Promise<void> {
    if (this.channel) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.openWaiters.push(waiter);
      setTimeout(() => {
        const index = this.openWaiters.indexOf(waiter);
        if (index < 0) return;
        this.openWaiters.splice(index, 1);
        reject(new GhostlyHttpError("timeout", "Timed out connecting to the peer"));
      }, timeoutMs);
      void this.dataLink.connect();
    });
  }

  disconnect(): void {
    this.dataLink.close();
  }

  /** Chat goes over the data link when it is up, through Pkarr otherwise. */
  async sendMessage(text: string, timestamp = Date.now()): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (this.channel && trimmed.length <= LIMITS.maxChatMessageBytes / 4) {
      try {
        this.channel.send(encodeControl({ t: "m", ts: timestamp, m: trimmed }));
        return null;
      } catch {
        // fall through to Pkarr
      }
    }
    return this.session.sendMessage(trimmed, timestamp);
  }

  /** Publishes a `_call` signal; a connected peer also gets it right away over the data link. */
  async setCallSignal(signal: string | null): Promise<void> {
    if (signal && this.channel) {
      try {
        this.channel.send(encodeControl({ t: "call", s: signal }));
      } catch {
        // Pkarr still carries it
      }
    }
    await this.session.setCallSignal(signal);
  }

  /** Issues an HTTP request to a service the peer advertises. */
  async request(serviceId: string, request: ClientRequest): Promise<ClientResponse> {
    await this.connect();
    if (!this.httpClient) throw new GhostlyHttpError("closed", "Data link is closed");
    return this.httpClient.request(serviceId, request);
  }

  /** Sends a file over the data link, opening it first if needed. Files never travel through Pkarr. */
  async sendFile(file: FileInfo, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.connect();
    if (!this.files) throw new GhostlyHttpError("closed", "Data link is closed");
    await this.files.send(file, source);
  }

  /** Call after the set of shared services changed. */
  async refreshServices(): Promise<void> {
    if (this.channel) {
      try {
        this.channel.send(encodeControl({ t: "svc", svc: servicesToWire(this.options.getServices() ?? []) }));
      } catch {
        // channel closing
      }
    }
    await this.session.refreshAdvertisement();
  }

  /** Only the lower key offers, so two peers coming online together do not collide. */
  private maybeAutoConnect(presence: PeerPresence): void {
    if (!this.options.autoConnect || !presence.online || this.channel || this.dataLink.state !== "idle") return;
    if (this.myPubKeyZ32 > this.options.params.peerPubKeyZ32) return;
    if (Date.now() - this.lastAutoConnectAt < AUTO_CONNECT_RETRY_MS) return;
    this.lastAutoConnectAt = Date.now();
    void this.dataLink.connect();
  }

  private mergePresence(presence: PeerPresence): PeerPresence {
    if (!this.channel) return presence;
    return { ...presence, online: true, services: this.peerServicesOverride ?? presence.services };
  }

  private attach(channel: FrameChannel): void {
    this.channel = channel;
    this.httpClient = new HttpClient(channel);
    this.httpHost = new HttpHost(channel, this.options.getHostedHttpService, this.options.localFetch);
    const events = this.options.events ?? {};
    this.files = new FileTransfers(channel, {
      onIncoming: (file) => events.onFileIncoming?.(file) ?? null,
      onProgress: (id, transferred, direction) => events.onFileProgress?.(id, transferred, direction),
      onComplete: (id, direction) => events.onFileComplete?.(id, direction),
      onFailed: (id, reason, direction) => events.onFileFailed?.(id, reason, direction),
    });
    this.session.setDataLinkOpen(true);

    channel.onMessage = (data) => this.handleFrame(data);
    channel.send(
      encodeControl({
        t: "hello",
        v: PROTOCOL_VERSION,
        svc: servicesToWire(this.options.getServices() ?? []),
        nick: this.options.nick,
      }),
    );
    // Whatever was still waiting in Pkarr for the peer's next poll goes now.
    for (const message of this.session.takeUnacknowledged()) {
      channel.send(encodeControl({ t: "m", ts: message.t, m: message.m }));
    }
    this.options.events?.onPresence?.(this.presence);
    for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
  }

  private detach(): void {
    this.httpHost?.closeAll();
    this.httpClient?.close();
    this.files?.closeAll();
    this.channel = this.httpHost = this.httpClient = this.files = null;
    this.peerServicesOverride = null;
    this.session.setDataLinkOpen(false);
    this.options.events?.onPresence?.(this.presence);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.openWaiters.splice(0)) waiter.reject(error);
  }

  private handleFrame(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      const chunk = decodeChunk(data);
      if (!chunk) return;
      if (chunk.kind === CHUNK_KIND.requestBody) this.httpHost?.handleChunk(chunk);
      else if (chunk.kind === CHUNK_KIND.responseBody) this.httpClient?.handleChunk(chunk);
      else this.files?.handleChunk(chunk);
      return;
    }

    const frame = decodeControl(data);
    if (!frame) return;
    switch (frame.t) {
      case "hello":
      case "svc": {
        const services = servicesFromWire(frame.svc);
        if (services) {
          this.peerServicesOverride = services;
          this.options.events?.onPresence?.(this.presence);
        }
        break;
      }
      case "m":
        this.options.events?.onMessage?.({ text: frame.m, timestamp: frame.ts, via: "datalink" });
        break;
      case "call":
        this.options.events?.onCallSignal?.(frame.s);
        break;
      case "req":
        this.httpHost?.handleRequest(frame);
        break;
      case "res":
        this.httpClient?.handleResponse(frame);
        break;
      case "file":
        this.files?.handleFile(frame);
        break;
      case "rst":
        if (frame.d === "q") this.httpHost?.handleReset(frame);
        else if (frame.d === "s") this.httpClient?.handleReset(frame);
        else this.files?.handleReset(frame);
        break;
      case "ping":
        try {
          this.channel?.send(encodeControl({ t: "pong", ts: frame.ts }));
        } catch {
          // channel closing
        }
        break;
      case "pong":
        break;
    }
  }
}
