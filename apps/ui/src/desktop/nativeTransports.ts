import { Channel, invoke } from "@tauri-apps/api/core";
import { fromBase64, irohDescriptor, irohRelayUrl, toBase64, type BoundChannel, type FrameChannel, type NativeBinding, type NativeEndpoint } from "@ghostly/core";

/** A frame Rust hands the page: text, or a binary message (HyperDHT only) in base64. */
type Event = { type: "open"; id: number; binding: NativeBinding; incoming: boolean }
  | { type: "frame"; id: number; text: string } | { type: "frame"; id: number; bytes: string } | { type: "closed"; id: number }
  /** HyperDHT: the runtime wrote frame `seq` and its socket has room for more, or (`unsent`) it could not send it. */
  | { type: "sent"; id: number; seq: number } | { type: "unsent"; id: number; seq: number }
  /** The endpoint itself ended in Rust (HyperDHT: its runtime died or dropped it). */
  | { type: "stopped" }
  /** The endpoint's own address came to be another (Iroh: it homed on a relay, the network changed). */
  | { type: "address"; descriptor: unknown };

/**
 * What a HyperDHT channel may have on the way. Its frames count until the runtime says `sent`, a trip from the page to
 * the runtime and back, so it holds more than Iroh's 120 KiB: a file's quarter of it is four 16 KiB chunks on the way,
 * where two were while a frame counted only until Rust queued it.
 */
const HYPERDHT_SEND_BUDGET = 256 * 1024;

/**
 * Ordered IPC writes and bounded buffering before the session installs its reader. Iroh's frames count against the send
 * budget until Rust answered; HyperDHT's until its runtime says it sent them (`sent`), while the next ones go on, so a
 * frame costs no round trip to the runtime.
 */
class NativeChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: (string | Uint8Array)[] = [];
  private queue = Promise.resolve();
  private closed = false;
  /** HyperDHT: frames the runtime has not said it sent, by number, with their size. */
  private unsent = new Map<number, number>();
  private seq = 0;
  private waiting: (() => void)[] = [];
  bufferedAmount = 0;
  readonly sendBudget: number;
  /** HyperDHT's frames mark a binary message (WISP 103 § Frames), and its sidecar and Rust carry one; Iroh's take text only. */
  readonly binary: boolean;
  onClose: FrameChannel["onClose"] = null;
  constructor(readonly id: number, private endpointId: () => number, private kind: "iroh" | "hyperdht") {
    this.binary = kind === "hyperdht";
    this.sendBudget = kind === "hyperdht" ? HYPERDHT_SEND_BUDGET : 120 * 1024;
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
    this.unsent.set(seq, data.length);
    // Rust answers once it queued the frame for the runtime: the chain keeps them in order, not waiting on the network.
    this.queue = this.queue.then(async () => {
      if (!this.closed) await invoke("paired_hyperdht_send", { endpointId: this.endpointId(), connectionId: this.id, seq, ...frame });
    }).catch(() => this.close());
  }
  /** HyperDHT: the runtime sent frame `seq`. */
  sent(seq: number) {
    const size = this.unsent.get(seq);
    if (size === undefined) return;
    this.unsent.delete(seq);
    this.bufferedAmount -= size;
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
    for (const size of this.unsent.values()) this.bufferedAmount -= size;
    this.unsent.clear();
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
    else if (event.type === "sent") (connections.get(event.id)?.channel as NativeChannel | undefined)?.sent(event.seq);
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
  let handler: NativeEndpoint["onConnection"] = null;
  const endpoint: NativeEndpoint = {
    transport: kind === "iroh" ? "iroh/1" : "hyperdht/1", descriptor: moved ?? result.descriptor, onDescriptor: null,
    get onConnection() { return handler; },
    set onConnection(value) { handler = value; if (value) for (const bound of early.splice(0)) value(bound); },
    get onUnavailable() { return unavailable; },
    set onUnavailable(value) { unavailable = value; if (value && ended) queueMicrotask(gone); },
    async connect(descriptor) {
      if (stopped) throw new Error("Native endpoint is stopped");
      // Iroh takes a relay spelled another way for another relay, and the native one homes on names with the trailing dot; a browser's record has none.
      const id = await invoke<number>(`paired_${kind}_connect`, { endpointId: result.id, descriptor: kind === "iroh" ? irohDescriptor(descriptor) : descriptor });
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
