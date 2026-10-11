import { Channel, invoke } from "@tauri-apps/api/core";
import { irohDescriptor, irohRelayUrl, type BoundChannel, type FrameChannel, type NativeBinding, type NativeEndpoint } from "@ghostly/core";

type Event = { type: "open"; id: number; binding: NativeBinding; incoming: boolean }
  | { type: "frame"; id: number; text: string } | { type: "closed"; id: number }
  /** The endpoint itself ended in Rust (HyperDHT: its runtime died or dropped it). */
  | { type: "stopped" }
  /** The endpoint's own address came to be another (Iroh: it homed on a relay, the network changed). */
  | { type: "address"; descriptor: unknown };

/** Ordered IPC writes and bounded buffering before the session installs its reader. */
class NativeChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: string[] = [];
  private queue = Promise.resolve();
  private closed = false;
  bufferedAmount = 0;
  readonly sendBudget = 120 * 1024;
  onClose: FrameChannel["onClose"] = null;
  constructor(readonly id: number, private endpointId: () => number, private kind: "iroh" | "hyperdht") {}
  get onMessage() { return this.reader; }
  set onMessage(reader: FrameChannel["onMessage"]) {
    this.reader = reader;
    if (reader) for (const text of this.buffered.splice(0)) reader(text);
  }
  receive(text: string) {
    if (this.closed) return;
    if (this.reader) this.reader(text);
    else if (this.buffered.length < 64) this.buffered.push(text);
    else this.close();
  }
  send(data: string | Uint8Array) {
    if (typeof data !== "string" || this.closed || this.bufferedAmount + data.length > this.sendBudget)
      throw new Error("Native channel is closed or its send budget is full");
    this.bufferedAmount += data.length;
    this.queue = this.queue.then(async () => {
      if (!this.closed) await invoke(this.kind === "iroh" ? "paired_native_send" : "paired_hyperdht_send", { endpointId: this.endpointId(), connectionId: this.id, text: data });
    }).catch(() => this.close()).finally(() => { this.bufferedAmount -= data.length; });
  }
  drained() { return this.queue; }
  close() {
    if (this.closed) return;
    this.closed = true; this.buffered = [];
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
    } else if (event.type === "frame") (connections.get(event.id)?.channel as NativeChannel | undefined)?.receive(event.text);
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
