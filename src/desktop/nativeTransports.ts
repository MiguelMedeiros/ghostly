import { Channel, invoke } from "@tauri-apps/api/core";
import type { BoundChannel, FrameChannel, NativeBinding, NativeEndpoint } from "@ghostly/core";

type Event = { type: "open"; id: number; binding: NativeBinding; incoming: boolean }
  | { type: "frame"; id: number; text: string } | { type: "closed"; id: number };

/** Ordered IPC writes and bounded buffering before the session installs its reader. */
class NativeChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: string[] = [];
  private queue = Promise.resolve();
  private closed = false;
  bufferedAmount = 0;
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
    if (typeof data !== "string" || this.closed || this.bufferedAmount + data.length > 120 * 1024)
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

export async function createNativeEndpoint(seedB64: string, kind: "iroh" | "hyperdht"): Promise<NativeEndpoint> {
  let endpointId = 0;
  const connections = new Map<number, BoundChannel>();
  const events = new Channel<Event>();
  let stopped = false;
  const lifecycle: { endpoint?: NativeEndpoint } = {};
  const early: BoundChannel[] = [];
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
    else { connections.get(event.id)?.channel.close(); connections.delete(event.id); }
  };
  const result = await invoke<{ id: number; descriptor: unknown }>(`paired_${kind}_start`, { seedB64, events });
  endpointId = result.id;
  let handler: NativeEndpoint["onConnection"] = null;
  const refresh = setInterval(() => {
    void invoke(`paired_${kind}_address`, { endpointId: result.id }).then(descriptor => {
      const endpoint = lifecycle.endpoint;
      if (stopped || !endpoint || JSON.stringify(descriptor) === JSON.stringify(endpoint.descriptor)) return;
      endpoint.descriptor = descriptor; endpoint.onDescriptor?.();
    }).catch(() => {
      if (stopped) return;
      lifecycle.endpoint?.onUnavailable?.();
      void lifecycle.endpoint?.close().catch(() => {});
    });
  }, 5000);
  const endpoint: NativeEndpoint = {
    transport: kind === "iroh" ? "iroh/1" : "hyperdht/1", descriptor: result.descriptor, onDescriptor: null,
    get onConnection() { return handler; },
    set onConnection(value) { handler = value; if (value) for (const bound of early.splice(0)) value(bound); },
    async connect(descriptor) {
      if (stopped) throw new Error("Native endpoint is stopped");
      const id = await invoke<number>(`paired_${kind}_connect`, { endpointId: result.id, descriptor });
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
      stopped = true; clearInterval(refresh);
      for (const bound of connections.values()) bound.channel.close();
      connections.clear();
      await invoke(`paired_${kind}_stop`, { endpointId: result.id });
    },
  };
  lifecycle.endpoint = endpoint;
  return endpoint;
}

export const createIrohEndpoint = (seed: string) => createNativeEndpoint(seed, "iroh");
export const createHyperEndpoint = (seed: string) => createNativeEndpoint(seed, "hyperdht");
