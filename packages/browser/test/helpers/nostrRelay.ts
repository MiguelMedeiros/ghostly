import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { finalizeEvent, verifyEvent, type EventTemplate } from "nostr-tools/pure";

/**
 * A Nostr relay in the test process (NIP-01: REQ/EVENT/CLOSE, EOSE, OK), on a loopback port. Keeps
 * what a relay keeps: every event, the newest version of a replaceable one. Disposable keys only; nothing
 * reaches a public relay.
 */
export interface StoredEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
interface Filter { kinds?: number[]; authors?: string[]; ids?: string[]; since?: number; until?: number; limit?: number; "#p"?: string[]; "#e"?: string[] }

const replaceable = (kind: number) => kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000);

export function matches(e: StoredEvent, f: Filter): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  if (f["#p"] && !e.tags.some(t => t[0] === "p" && f["#p"]!.includes(t[1]))) return false;
  if (f["#e"] && !e.tags.some(t => t[0] === "e" && f["#e"]!.includes(t[1]))) return false;
  return true;
}

export class TestNostrRelay {
  readonly events: StoredEvent[] = [];
  /** Every filter asked, in order. */
  readonly requests: Filter[] = [];
  /** Every event published to this relay, in order. */
  readonly published: StoredEvent[] = [];
  /** Misbehaviour switches. */
  behaviour: { eose?: boolean; oversizeFrame?: boolean; rejectPublish?: string; silentPublish?: boolean } = { eose: true };
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  url = "";

  /** Adds an event the relay already holds (signed here with the given secret). */
  add(template: EventTemplate, secret: Uint8Array): StoredEvent {
    const event = finalizeEvent(template, secret) as StoredEvent;
    this.store({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig });
    return event;
  }
  private store(e: StoredEvent): void {
    if (replaceable(e.kind)) {
      const i = this.events.findIndex(x => x.kind === e.kind && x.pubkey === e.pubkey);
      if (i >= 0) { if (this.events[i].created_at > e.created_at || (this.events[i].created_at === e.created_at && this.events[i].id < e.id)) return; this.events.splice(i, 1); }
    }
    if (!this.events.some(x => x.id === e.id)) this.events.push(e);
  }
  select(f: Filter): StoredEvent[] {
    return this.events.filter(e => matches(e, f)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, f.limit ?? 500);
  }

  async listen(): Promise<string> {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server, maxPayload: 256 * 1024 });
    this.wss.on("connection", socket => {
      socket.on("message", raw => {
        let frame: unknown[];
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (!Array.isArray(frame)) return;
        if (frame[0] === "REQ") {
          const [, sub, filter] = frame as [string, string, Filter];
          this.requests.push(filter);
          if (this.behaviour.oversizeFrame) { socket.send(JSON.stringify(["EVENT", sub, { junk: "x".repeat(70 * 1024) }])); return; }
          for (const e of this.select(filter)) socket.send(JSON.stringify(["EVENT", sub, e]));
          if (this.behaviour.eose !== false) socket.send(JSON.stringify(["EOSE", sub]));
        } else if (frame[0] === "EVENT") {
          const e = frame[1] as StoredEvent;
          if (this.behaviour.silentPublish) return;
          if (this.behaviour.rejectPublish) { socket.send(JSON.stringify(["OK", e.id, false, this.behaviour.rejectPublish])); return; }
          if (!verifyEvent(e)) { socket.send(JSON.stringify(["OK", e.id, false, "invalid: bad signature"])); return; }
          this.published.push(e);
          this.store(e);
          socket.send(JSON.stringify(["OK", e.id, true, ""]));
        }
      });
    });
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", () => resolve()));
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>(resolve => this.wss ? this.wss.close(() => resolve()) : resolve());
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }
}

/** The `ws` client as the engine's WebSocket. */
export const nodeSocket = (url: string) => new WebSocket(url) as unknown as globalThis.WebSocket;
