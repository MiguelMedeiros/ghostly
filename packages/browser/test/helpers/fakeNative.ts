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
  private held = new Map<NativeTransport, (() => void)[]>();

  /**
   * Dials over `transport` wait from now on, as a handshake that takes long would, so a test can act while one is
   * in flight. The returned release fails the waiting dials and lets later ones through.
   */
  hold(transport: NativeTransport): () => void {
    const waiting: (() => void)[] = [];
    this.held.set(transport, waiting);
    return () => { if (this.held.get(transport) === waiting) this.held.delete(transport); for (const fail of waiting.splice(0)) fail(); };
  }

  /**
   * `kind`: how the endpoint describes itself. Absent: by name (`{ id: "<name>:<transport>" }`), for tests that hand
   * descriptors over themselves. Otherwise as the real adapters do, so a capability record can carry it (a 64-hex Iroh
   * endpoint id, or HyperDHT public key): `direct`, a native endpoint (an Iroh one homed on its relay, with its
   * addresses); for Iroh also `relay-only`, a browser's,
   * reachable through its relay alone (its descriptor names the relay and no address) and able to dial only a
   * descriptor that names one; and `relay-later`, the Desktop's, homed on a relay a few seconds after it binds: it
   * names none until `homeRelay()`, which then tells the owner, as the Desktop's address refresh does.
   */
  endpoint(transport: NativeTransport, name: string, kind?: "direct" | "relay-only" | "relay-later"): NativeEndpoint & { homeRelay(): void } {
    const id = kind ? hex(32) : `${name}:${transport}`, identity = hex(32);
    const entry = { identity, closed: false, endpoint: null as unknown as NativeEndpoint & { homeRelay(): void } };
    const descriptor = !kind ? { id } : transport === "hyperdht/1" ? { publicKey: id }
      : kind === "relay-only" ? { id, relay: "https://relay.test/", addresses: [], relayed: true }
      : { id, relay: kind === "direct" ? "https://relay.test./" : null, addresses: ["192.0.2.1:4000"] };
    entry.endpoint = {
      transport, descriptor, onConnection: null, onDescriptor: null,
      homeRelay: () => { entry.endpoint.descriptor = { ...descriptor, relay: "https://relay.test./" }; entry.endpoint.onDescriptor?.(); },
      connect: async descriptor => {
        const waiting = this.held.get(transport);
        if (waiting) await new Promise<void>((_, reject) => waiting.push(() => reject(new Error(`${transport} dial abandoned`))));
        const d = descriptor as { id?: string; publicKey?: string; relay?: unknown } | undefined;
        const remote = this.endpoints.get(d?.id ?? d?.publicKey ?? "");
        // A page cannot send UDP: without the contact's relay there is no way to it (the wasm adapter's words).
        if (kind === "relay-only" && !d?.relay) throw new Error("The contact has no Iroh relay");
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
