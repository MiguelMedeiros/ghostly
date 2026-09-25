import type { BoundChannel, FrameChannel, NativeEndpoint, NativeTransport } from "@ghostly/core";

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");

/**
 * Iroh and HyperDHT stood in for in one process: endpoints dial each other by descriptor and get a channel pair
 * with a matching binding (a fresh exporter/handshake-hash-shaped context, the two endpoint identities), as the
 * real adapters hand over after their handshake. Frames take `latencyMs` of real time, and a frame still on its way
 * when either end closes is lost, as it would be on a real socket: a switch has a window where frames can vanish.
 */
export class FakeNativeNet {
  latencyMs = 2;
  /** Transports whose dials fail, as an unreachable relay or a blocked port would. */
  readonly unreachable = new Set<NativeTransport>();
  /** Every channel opened, newest last. */
  readonly channels: FrameChannel[] = [];
  private endpoints = new Map<string, { endpoint: NativeEndpoint; identity: string; closed: boolean }>();

  endpoint(transport: NativeTransport, name: string): NativeEndpoint {
    const id = `${name}:${transport}`, identity = hex(32);
    const entry = { identity, closed: false, endpoint: null as unknown as NativeEndpoint };
    entry.endpoint = {
      transport, descriptor: { id }, onConnection: null, onDescriptor: null,
      connect: async descriptor => {
        const remote = this.endpoints.get((descriptor as { id?: string })?.id ?? "");
        if (this.unreachable.has(transport)) throw new Error(`${transport} unreachable`);
        if (!remote || remote.closed || entry.closed) throw new Error("Peer native address unavailable");
        const [mine, theirs] = this.pair();
        const binding = { transport, context: hex(transport === "hyperdht/1" ? 64 : 32), identities: [identity, remote.identity] as [string, string] };
        setTimeout(() => {
          if (remote.closed || !remote.endpoint.onConnection) { theirs.close(); return; }
          remote.endpoint.onConnection({ channel: theirs, binding: { ...binding, identities: [remote.identity, identity] } });
        }, this.latencyMs);
        return { channel: mine, binding } satisfies BoundChannel;
      },
      close: async () => { entry.closed = true; },
    };
    this.endpoints.set(id, entry);
    return entry.endpoint;
  }

  private pair(): [FrameChannel, FrameChannel] {
    const make = () => {
      let reader: FrameChannel["onMessage"] = null;
      const waiting: (string | Uint8Array)[] = [];
      const end = {
        closed: false, peer: null as unknown as FrameChannel & { closed: boolean; deliver(data: string | Uint8Array): void },
        bufferedAmount: 0, drained: async () => {}, onClose: null as FrameChannel["onClose"],
        get onMessage() { return reader; },
        set onMessage(value: FrameChannel["onMessage"]) { reader = value; if (value) for (const data of waiting.splice(0)) value(data); },
        deliver(data: string | Uint8Array) { if (this.closed) return; if (reader) reader(data); else waiting.push(data); },
        send: (data: string | Uint8Array) => {
          if (end.closed) throw new Error("Connection closed");
          const copy = typeof data === "string" ? data : data.slice();
          setTimeout(() => { if (!end.closed) end.peer.deliver(copy); }, this.latencyMs);
        },
        close() {
          if (end.closed) return;
          end.closed = true; end.onClose?.();
          end.peer.close();
        },
      };
      return end;
    };
    const a = make(), b = make();
    a.peer = b; b.peer = a;
    this.channels.push(a, b);
    return [a, b];
  }
}
