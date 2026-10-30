import { Channel, invoke } from "@tauri-apps/api/core";
import { fromBase64, irohDescriptor, irohRelayUrl, toBase64, type BoundChannel, type FrameChannel, type NativeBinding, type NativeEndpoint } from "@ghostly/core";

/** A frame Rust hands the page: text, or a binary message (HyperDHT only) in base64. */
type Event = { type: "open"; id: number; binding: NativeBinding; incoming: boolean }
  | { type: "frame"; id: number; text: string } | { type: "frame"; id: number; bytes: string } | { type: "closed"; id: number }
  /**
   * HyperDHT: the connection's socket in the runtime holds more than it should (`full`) or has room again (`room`), or
   * (`unsent`) it could not send frame `seq`. A frame that found room is answered by nothing.
   */
  | { type: "full"; id: number } | { type: "room"; id: number } | { type: "unsent"; id: number; seq: number }
  /** The endpoint itself ended in Rust (HyperDHT: its runtime died or dropped it). */
  | { type: "stopped" }
  /** The endpoint's own address came to be another (Iroh: it homed on a relay, the network changed). */
  | { type: "address"; descriptor: unknown };

/**
 * Ordered IPC writes and bounded buffering before the session installs its reader. A frame counts against the send
 * budget until Rust answered (HyperDHT: once it queued it for the runtime). While HyperDHT's runtime says the
 * connection's socket is full, a file's quarter of the budget counts as well, so a file waits and a message still
 * fits: the runtime speaks only then, as a word back for every frame cost a file about a fifth of its speed.
 */
class NativeChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: (string | Uint8Array)[] = [];
  private queue = Promise.resolve();
  private closed = false;
  private seq = 0;
  /** HyperDHT: the runtime said the connection's socket is full, and not yet that it has room. */
  private full = false;
  private waiting: (() => void)[] = [];
  /** The frame Rust holds for this connection's exit (`parting`). */
  private last: string | null = null;
  bufferedAmount = 0;
  readonly sendBudget = 120 * 1024;
  /** HyperDHT's frames mark a binary message (WISP 103 § Frames), and its sidecar and Rust carry one; Iroh's take text only. */
  readonly binary: boolean;
  onClose: FrameChannel["onClose"] = null;
  constructor(readonly id: number, private endpointId: () => number, private kind: "iroh" | "hyperdht") {
    this.binary = kind === "hyperdht";
  }
  get onMessage() { return this.reader; }
  set onMessage(reader: FrameChannel["onMessage"]) {
    this.reader = reader;
    if (reader) for (const data of this.buffered.splice(0)) reader(data);
  }
  receive(data: string | Uint8Array) {
    if (this.closed) return;
    if (this.reader) this.reader(data);
    else if (this.buffered.length < 64) this.buffered.push(data);
    else this.close();
  }
  send(data: string | Uint8Array) {
    if ((typeof data !== "string" && !this.binary) || this.closed || this.bufferedAmount + data.length > this.sendBudget)
      throw new Error("Native channel is closed or its send budget is full");
    this.bufferedAmount += data.length;
    const frame = typeof data === "string" ? { text: data } : { bytes: toBase64(data) };
    if (this.kind === "iroh") {
      this.queue = this.queue.then(async () => {
        if (!this.closed) await invoke("paired_native_send", { endpointId: this.endpointId(), connectionId: this.id, ...frame });
      }).catch(() => this.close()).finally(() => { this.bufferedAmount -= data.length; });
      return;
    }
    const seq = ++this.seq;
    // Rust answers once it queued the frame for the runtime: the chain keeps them in order, not waiting on the network.
    this.queue = this.queue.then(async () => {
      if (!this.closed) await invoke("paired_hyperdht_send", { endpointId: this.endpointId(), connectionId: this.id, seq, ...frame });
    }).catch(() => this.close()).finally(() => { this.bufferedAmount -= data.length; this.wake(); });
  }
  /**
   * Rust holds `frame` for this connection and sends it as the app exits, after whatever the page sent: the page may be
   * gone by then (a logout ends WebKit's processes with the app). In order with the sends, and only when it changed.
   */
  parting(frame: string | null) {
    if (this.closed || frame === this.last) return;
    this.last = frame;
    const command = this.kind === "iroh" ? "paired_native_parting" : "paired_hyperdht_parting";
    this.queue = this.queue.then(async () => {
      if (!this.closed) await invoke(command, { endpointId: this.endpointId(), connectionId: this.id, text: frame });
    }).catch(() => {});
  }
  /** HyperDHT: the runtime's socket for this connection is full (`true`) or has room again. */
  held(full: boolean) {
    if (this.closed || full === this.full) return;
    this.full = full;
    this.bufferedAmount += (full ? 1 : -1) * this.sendBudget / 4;
    this.wake();
  }
  private wake() {
    if (this.bufferedAmount < this.sendBudget / 4) for (const resolve of this.waiting.splice(0)) resolve();
  }
  /** Iroh: once Rust answered every send. HyperDHT: once under a quarter of the budget, what a file may hold in it. */
  drained() {
    if (this.kind === "iroh") return this.queue;
    if (this.closed || this.bufferedAmount < this.sendBudget / 4) return Promise.resolve();
    return new Promise<void>(resolve => this.waiting.push(resolve));
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.buffered = [];
    if (this.full) { this.full = false; this.bufferedAmount -= this.sendBudget / 4; }
    for (const resolve of this.waiting.splice(0)) resolve();
    void invoke(this.kind === "iroh" ? "paired_native_close" : "paired_hyperdht_close", { endpointId: this.endpointId(), connectionId: this.id }).catch(() => {});
    this.onClose?.();
  }
}

/**
 * An endpoint of the Desktop's own Iroh or HyperDHT. `relays`: the Iroh relays it homes on (Settings, Network); without
 * any, `GHOSTLY_IROH_RELAYS` where set (tests), else n0's public relays.
 */
export async function createNativeEndpoint(seedB64: string, kind: "iroh" | "hyperdht", options: { relays?: string[] } = {}): Promise<NativeEndpoint> {
  let endpointId = 0;
  const connections = new Map<number, BoundChannel>();
  const events = new Channel<Event>();
  let stopped = false;
  const lifecycle: { endpoint?: NativeEndpoint } = {};
  const early: BoundChannel[] = [];
  // Rust said the endpoint ended. Whoever holds it is told once, even when it starts listening after the word came.
  let ended = false;
  // An address Rust sent before `paired_iroh_start` answered here: newer than the one in that answer.
  let moved: unknown;
  let unavailable: NativeEndpoint["onUnavailable"] = null;
  const gone = () => {
    const endpoint = lifecycle.endpoint;
    if (stopped || !endpoint || !unavailable) return;
    unavailable();
    void endpoint.close().catch(() => {});
  };
  events.onmessage = event => {
    if (event.type === "open") {
      const bound = { channel: new NativeChannel(event.id, () => endpointId, kind), binding: event.binding };
      if (stopped) { bound.channel.close(); return; }
      connections.set(event.id, bound);
      if (event.incoming) {
        if (lifecycle.endpoint?.onConnection) lifecycle.endpoint.onConnection(bound);
        else early.push(bound);
      }
    } else if (event.type === "frame") (connections.get(event.id)?.channel as NativeChannel | undefined)?.receive("bytes" in event ? fromBase64(event.bytes) : event.text);
    else if (event.type === "full" || event.type === "room") (connections.get(event.id)?.channel as NativeChannel | undefined)?.held(event.type === "full");
    else if (event.type === "unsent") connections.get(event.id)?.channel.close();
    else if (event.type === "stopped") { ended = true; gone(); }
    else if (event.type === "address") {
      const endpoint = lifecycle.endpoint;
      if (stopped) return;
      if (!endpoint) { moved = event.descriptor; return; }
      endpoint.descriptor = event.descriptor; endpoint.onDescriptor?.();
    }
    else { connections.get(event.id)?.channel.close(); connections.delete(event.id); }
  };
  // In the spelling native Iroh names relays with (the trailing dot), as a contact's record and the dial use.
  const relays = kind === "iroh" && options.relays?.length ? { relays: options.relays.map((relay) => irohRelayUrl(relay)) } : {};
  const result = await invoke<{ id: number; descriptor: unknown }>(`paired_${kind}_start`, { seedB64, ...relays, events });
  endpointId = result.id;
  // HyperDHT: Rust runs one dial per endpoint and refuses another while it is pending. One to the same contact (a
  // transport chosen while the chat's own redial runs) joins it: the newest caller gets its connection or its failure,
  // and the ones before it, let go for that one, an error, so a connection never goes to two holders.
  let dialing: { key: unknown; owner: object; answer: Promise<number> } | undefined;
  const dial = async (descriptor: unknown): Promise<number> => {
    // Iroh takes a relay spelled another way for another relay, and the native one homes on names with the trailing dot; a browser's record has none.
    const ask = () => invoke<number>(`paired_${kind}_connect`, { endpointId: result.id, descriptor: kind === "iroh" ? irohDescriptor(descriptor) : descriptor });
    if (kind === "iroh") return ask();
    const key = (descriptor as { publicKey?: unknown } | undefined)?.publicKey, turn = {};
    let joined = typeof key === "string" && dialing?.key === key ? dialing : undefined;
    if (joined) joined.owner = turn;
    else {
      const mine = joined = dialing = { key, owner: turn, answer: ask() };
      mine.answer.finally(() => { if (dialing === mine) dialing = undefined; }).catch(() => {});
    }
    const id = await joined.answer;
    if (joined.owner !== turn) throw new Error("A newer dial of this contact took the connection");
    return id;
  };
  let handler: NativeEndpoint["onConnection"] = null;
  const endpoint: NativeEndpoint = {
    transport: kind === "iroh" ? "iroh/1" : "hyperdht/1", descriptor: moved ?? result.descriptor, onDescriptor: null,
    get onConnection() { return handler; },
    set onConnection(value) { handler = value; if (value) for (const bound of early.splice(0)) value(bound); },
    get onUnavailable() { return unavailable; },
    set onUnavailable(value) { unavailable = value; if (value && ended) queueMicrotask(gone); },
    async connect(descriptor) {
      if (stopped) throw new Error("Native endpoint is stopped");
      const id = await dial(descriptor);
      // Tauri channels and command results can be dispatched in separate turns.
      for (let attempt = 0; attempt < 100; attempt++) {
        const bound = connections.get(id);
        if (bound) return bound;
        if (stopped) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      void invoke(kind === "iroh" ? "paired_native_close" : "paired_hyperdht_close", { endpointId: result.id, connectionId: id });
      throw new Error("Native channel did not reach the application");
    },
    async close() {
      stopped = true;
      for (const bound of connections.values()) bound.channel.close();
      connections.clear();
      await invoke(`paired_${kind}_stop`, { endpointId: result.id });
    },
  };
  lifecycle.endpoint = endpoint;
  return endpoint;
}

export const createIrohEndpoint = (seed: string, options?: { relays?: string[] }) => createNativeEndpoint(seed, "iroh", options);
export const createHyperEndpoint = (seed: string) => createNativeEndpoint(seed, "hyperdht");
