import type { BrowserContext, WebSocketRoute } from "@playwright/test";
import { finalizeEvent, verifyEvent, type EventTemplate } from "nostr-tools/pure";

/**
 * A Nostr relay that lives in the test process. A context's WebSocket connections to
 * `wss://relay.ghostly.test` are answered from here (Playwright routes the socket before anything
 * leaves the browser), so the suite needs no network, no port, and no real relay ever learns of a test
 * key. It keeps what a relay keeps (every event, the newest version of a replaceable one), answers
 * REQ with EVENTs then EOSE, and EVENT with OK. Every request is recorded with the name of the peer
 * that made it, so a test can assert who asked for what.
 */
export interface StoredEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
interface Filter { kinds?: number[]; authors?: string[]; ids?: string[]; since?: number; until?: number; limit?: number; "#p"?: string[]; "#e"?: string[] }

export const NOSTR_TEST_RELAY = "wss://relay.ghostly.test";
const replaceable = (kind: number) => kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000);

function matches(e: StoredEvent, f: Filter): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  if (f["#p"] && !e.tags.some(t => t[0] === "p" && f["#p"]!.includes(t[1]))) return false;
  if (f["#e"] && !e.tags.some(t => t[0] === "e" && f["#e"]!.includes(t[1]))) return false;
  return true;
}

export class LocalNostrRelay {
  readonly events: StoredEvent[] = [];
  /** Every filter asked, with who asked. */
  readonly requests: { by: string; filter: Filter }[] = [];
  /** Every event published, with who published it. */
  readonly published: { by: string; event: StoredEvent }[] = [];

  /** An event the relay already holds, signed here with a disposable key. */
  add(template: EventTemplate, secret: Uint8Array): StoredEvent {
    const e = finalizeEvent(template, secret);
    const event: StoredEvent = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
    this.store(event);
    return event;
  }
  private store(e: StoredEvent): void {
    if (replaceable(e.kind)) {
      const i = this.events.findIndex(x => x.kind === e.kind && x.pubkey === e.pubkey);
      if (i >= 0) { if (this.events[i].created_at > e.created_at) return; this.events.splice(i, 1); }
    }
    if (!this.events.some(x => x.id === e.id)) this.events.push(e);
  }
  select(f: Filter): StoredEvent[] {
    return this.events.filter(e => matches(e, f)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, f.limit ?? 500);
  }

  /**
   * Answers this context's connections to the test relay, recording them under `name`. `urls` adds relays it answers
   * as well (the app's defaults, for a person who never changed them): none of them is reached. Like any Playwright
   * route, it covers pages loaded after it: reload a page that was already open.
   */
  async attach(context: BrowserContext, name: string, urls: readonly string[] = []): Promise<void> {
    const answered = [NOSTR_TEST_RELAY, ...urls];
    await context.routeWebSocket(url => answered.some(relay => url.href.startsWith(relay)), (ws: WebSocketRoute) => {
      ws.onMessage(raw => {
        let frame: unknown[];
        try { frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
        if (!Array.isArray(frame)) return;
        if (frame[0] === "REQ") {
          const [, sub, filter] = frame as [string, string, Filter];
          this.requests.push({ by: name, filter });
          for (const e of this.select(filter)) ws.send(JSON.stringify(["EVENT", sub, e]));
          ws.send(JSON.stringify(["EOSE", sub]));
        } else if (frame[0] === "EVENT") {
          const e = frame[1] as StoredEvent;
          if (!verifyEvent(e)) { ws.send(JSON.stringify(["OK", e.id, false, "invalid: bad signature"])); return; }
          this.published.push({ by: name, event: e });
          this.store(e);
          ws.send(JSON.stringify(["OK", e.id, true, ""]));
        }
      });
    });
  }
}
