import type { FrameChannel } from "../../src/frames";
import type { BoundChannel, NativeEndpoint, NativeTransport } from "../../src/pairedTransports";

/**
 * Iroh and HyperDHT stood in for on fake time, for measuring how a chat comes back after one app restarts. Endpoints
 * are named, and a name keeps its id across restarts, as the real adapters do (each chat's transport seed is stored).
 * What matters here is what the far end sees when an app goes away:
 * - `close()` on a channel is a close the other end hears a moment later (QUIC's CONNECTION_CLOSE);
 * - `kill(name)` is the process ending with nothing said: its channels go dead, and the far end hears nothing until
 *   `idleMs` passed (QUIC's idle timeout, 30 s in Iroh), then sees its channel close.
 * Dials take `dialMs`; a dial to an endpoint that is not running fails after `dialFailMs`.
 */

interface End extends FrameChannel {
  closed: boolean;
  dead: boolean;
  peer: End;
  deliver(data: string | Uint8Array): void;
  hear(): void;
}

interface Entry { name: string; endpoint: NativeEndpoint; identity: string; closed: boolean; ends: End[] }

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");

export class NativeWorld {
  latencyMs = 60;
  dialMs = 400;
  dialFailMs = 5_000;
  idleMs = 30_000;
  /** Every dial that reached an endpoint, and every one that did not. */
  dials = 0;
  dialFailures = 0;
  private entries = new Map<string, Entry>();
  private identities = new Map<string, string>();

  /** The endpoint an app named `name` runs for `transport`; a restarted app gets a new one under the same id. */
  endpoint(transport: NativeTransport, name: string): NativeEndpoint {
    const id = `${name}:${transport}`;
    const identity = this.identities.get(id) ?? hex(32);
    this.identities.set(id, identity);
    const entry: Entry = { name, identity, closed: false, ends: [], endpoint: null as unknown as NativeEndpoint };
    const descriptor = transport === "hyperdht/1" ? { publicKey: id } : { id, relay: "https://relay.test./", addresses: [] };
    entry.endpoint = {
      transport, descriptor, onConnection: null, onDescriptor: null,
      connect: async (to: unknown): Promise<BoundChannel> => {
        const d = to as { id?: string; publicKey?: string };
        const remote = this.entries.get(d.id ?? d.publicKey ?? "");
        if (!remote || remote.closed || entry.closed || !remote.endpoint.onConnection) {
          this.dialFailures++;
          await after(this.dialFailMs);
          throw new Error(`${transport}: the contact's endpoint did not answer`);
        }
        await after(this.dialMs);
        if (remote.closed || entry.closed || this.entries.get(d.id ?? d.publicKey ?? "") !== remote) { this.dialFailures++; throw new Error(`${transport}: the contact's endpoint went away`); }
        this.dials++;
        const [mine, theirs] = this.pair(entry, remote);
        const binding = { transport, context: hex(transport === "hyperdht/1" ? 64 : 32), identities: [entry.identity, remote.identity] as [string, string] };
        remote.endpoint.onConnection?.({ channel: theirs, binding: { ...binding, identities: [remote.identity, entry.identity] } });
        return { channel: mine, binding };
      },
      close: async () => { entry.closed = true; for (const end of [...entry.ends]) end.close(); },
    };
    this.entries.set(id, entry);
    return entry.endpoint;
  }

  /** The app named `name` ends with nothing said: no close reaches anyone, the far ends time out. */
  kill(name: string): void {
    for (const entry of this.entries.values()) {
      if (entry.name !== name || entry.closed) continue;
      entry.closed = true;
      for (const end of entry.ends.splice(0)) {
        if (end.closed || end.dead) continue;
        end.dead = true;
        const far = end.peer;
        setTimeout(() => far.hear(), this.idleMs);
      }
    }
  }

  private pair(a: Entry, b: Entry): [End, End] {
    const make = (owner: Entry): End => {
      let reader: FrameChannel["onMessage"] = null;
      const waiting: (string | Uint8Array)[] = [];
      const end: End = {
        closed: false, dead: false, peer: null as unknown as End, bufferedAmount: 0, onClose: null,
        drained: () => Promise.resolve(),
        get onMessage() { return reader; },
        set onMessage(value) { reader = value; if (value) for (const data of waiting.splice(0)) value(data); },
        deliver(data) { if (end.closed || end.dead) return; if (reader) reader(data); else waiting.push(data); },
        send: (data) => {
          if (end.closed) throw new Error("Connection closed");
          if (end.dead) return;
          const copy = typeof data === "string" ? data : data.slice();
          setTimeout(() => { if (!end.dead) end.peer.deliver(copy); }, this.latencyMs);
        },
        close: () => {
          if (end.closed) return;
          end.closed = true;
          owner.ends = owner.ends.filter(e => e !== end);
          end.onClose?.();
          // The close reaches the other end a moment later, unless this app is gone (its end is dead).
          if (!end.dead) setTimeout(() => end.peer.hear(), this.latencyMs);
        },
        /** The far end closed (or timed out): this end closes, without telling anyone back. */
        hear: () => {
          if (end.closed) return;
          end.closed = true;
          owner.ends = owner.ends.filter(e => e !== end);
          end.onClose?.();
        },
      };
      owner.ends.push(end);
      return end;
    };
    const x = make(a), y = make(b);
    x.peer = y; y.peer = x;
    return [x, y];
  }
}

const after = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
