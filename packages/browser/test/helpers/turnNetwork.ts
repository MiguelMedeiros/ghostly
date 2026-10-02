import { turnPayloadSequence, type TurnConditions, type TurnNetwork, type TurnSourceAnswer, type TurnSourcePut } from "@ghostly/core";

/*
 * Sources of the turn record for tests, each keeping one packet per key and answering a put as the real ones were
 * measured to (WISP 06 § Measured, and still to measure):
 * - `dht`: a lower sequence is refused (302), a `cas` that names another sequence is refused (301), a different
 *   packet at an equal sequence is accepted and replaces the first;
 * - `relay`: a lower sequence is refused (409), `If-Match` is ignored, and of two packets at an equal sequence the
 *   one with the larger encoded bytes stays (pkarr-relay 2.1.0).
 */
export interface FakeSource {
  name: string;
  kind: "dht" | "relay";
  held: Uint8Array | null;
  /** The source does not answer: reads and puts fail. */
  down?: boolean;
  /** Takes every put and keeps answering what it held before: a source that lags for good. */
  frozen?: boolean;
  /** Refuses every put, whatever it holds. */
  refuses?: boolean;
  /** Answers reads, and fails every put (a timeout). */
  putFails?: boolean;
  /** Sequences it names on a read without handing an item over (a relay's header): unsigned. */
  sequences?: string[];
  /** Its read answers are marked stale (a relay asked plainly, from its cache). */
  stale?: boolean;
  /** Called between the conditions being checked and the packet being stored: where another device's put lands first. */
  beforePut?: () => void;
}

export interface TurnCall { op: "read" | "put"; source?: string; condition?: string | null; payload?: Uint8Array; timeoutMs?: number }

const larger = (a: Uint8Array, b: Uint8Array): boolean => {
  for (let i = 72; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] > b[i];
  return a.length > b.length;
};

export class FakeTurnNetwork implements TurnNetwork {
  readonly sources: FakeSource[];
  readonly calls: TurnCall[] = [];
  /** Called before every put reaches the sources, with the payload: for "stored before it is put". */
  onPut?: (payload: Uint8Array) => void | Promise<void>;
  /** Called after a read was answered and before the caller gets it: where another device acts in between. */
  afterRead?: () => void;
  /** As the Desktop puts: the DHT first, and the relays only once it stored. */
  dhtFirst = false;
  warmed = 0;
  async turnWarm(): Promise<void> { this.warmed++; }

  constructor(sources: { name: string; kind?: "dht" | "relay" }[] = [{ name: "dht", kind: "dht" }, { name: "https://relay.test", kind: "relay" }]) {
    this.sources = sources.map((source) => ({ name: source.name, kind: source.kind ?? "dht", held: null }));
  }

  source(name: string): FakeSource {
    const source = this.sources.find((s) => s.name === name);
    if (!source) throw new Error(`no source ${name}`);
    return source;
  }

  /** Puts a packet on every source, as another device would: lower sequences refused, nothing else asked. */
  seed(payload: Uint8Array | null, only?: string): void {
    for (const source of this.sources) if (!only || source.name === only) source.held = payload;
  }

  puts(): TurnCall[] { return this.calls.filter((call) => call.op === "put"); }
  reads(): number { return this.calls.filter((call) => call.op === "read").length; }

  async turnRead(_key?: string, options?: { timeoutMs?: number }): Promise<TurnSourceAnswer[]> {
    this.calls.push({ op: "read", ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
    const answers = this.sources.map((source): TurnSourceAnswer => (source.down
      ? { source: source.name, answered: false, payloads: [], detail: "no answer" }
      : { source: source.name, answered: true, payloads: source.held ? [source.held] : [], ...(source.sequences ? { sequences: source.sequences } : {}), ...(source.stale ? { stale: true } : {}) }));
    this.afterRead?.();
    return answers;
  }

  async turnPut(_key: string, payload: Uint8Array, conditions: TurnConditions): Promise<TurnSourcePut[]> {
    await this.onPut?.(payload);
    const results: TurnSourcePut[] = [];
    const ordered = this.dhtFirst ? [...this.sources].sort((a, b) => Number(b.kind === "dht") - Number(a.kind === "dht")) : this.sources;
    let dhtHeld = false;
    for (const source of ordered) {
      if (conditions[source.name] === undefined) continue;
      if (dhtHeld && source.kind === "relay") { results.push({ source: source.name, outcome: "failed", detail: "not sent: the DHT did not store it" }); continue; }
      const condition = conditions[source.name];
      this.calls.push({ op: "put", source: source.name, condition, payload });
      if (source.down || source.putFails) { results.push({ source: source.name, outcome: "failed", detail: "no answer" }); if (this.dhtFirst && source.kind === "dht") dhtHeld = true; continue; }
      if (source.refuses) { results.push({ source: source.name, outcome: "refused", detail: "HTTP 409" }); continue; }
      source.beforePut?.();
      const sequence = turnPayloadSequence(payload)!, heldSequence = source.held ? turnPayloadSequence(source.held)! : null;
      if (source.kind === "dht" && condition !== null && String(heldSequence) !== condition) { results.push({ source: source.name, outcome: "refused", detail: "301" }); dhtHeld = this.dhtFirst; continue; }
      if (heldSequence !== null && sequence < heldSequence) { results.push({ source: source.name, outcome: "refused", detail: source.kind === "dht" ? "302" : "HTTP 409" }); if (source.kind === "dht") dhtHeld = this.dhtFirst; continue; }
      if (source.kind === "relay" && heldSequence === sequence && source.held && larger(source.held, payload)) { results.push({ source: source.name, outcome: "refused", detail: "HTTP 409" }); continue; }
      if (!source.frozen) source.held = payload;
      results.push({ source: source.name, outcome: "stored" });
    }
    return results;
  }
}
