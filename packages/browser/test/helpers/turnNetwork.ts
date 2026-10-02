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
  /** Called between the conditions being checked and the packet being stored: where another device's put lands first. */
  beforePut?: () => void;
}

export interface TurnCall { op: "read" | "put"; source?: string; condition?: string | null; payload?: Uint8Array }

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

  async turnRead(): Promise<TurnSourceAnswer[]> {
    this.calls.push({ op: "read" });
    const answers = this.sources.map((source): TurnSourceAnswer => (source.down
      ? { source: source.name, answered: false, payloads: [], detail: "no answer" }
      : { source: source.name, answered: true, payloads: source.held ? [source.held] : [] }));
    this.afterRead?.();
    return answers;
  }

  async turnPut(_key: string, payload: Uint8Array, conditions: TurnConditions): Promise<TurnSourcePut[]> {
    await this.onPut?.(payload);
    const results: TurnSourcePut[] = [];
    for (const source of this.sources) {
      if (conditions[source.name] === undefined) continue;
      const condition = conditions[source.name];
      this.calls.push({ op: "put", source: source.name, condition, payload });
      if (source.down) { results.push({ source: source.name, outcome: "failed", detail: "no answer" }); continue; }
      source.beforePut?.();
      const sequence = turnPayloadSequence(payload)!, heldSequence = source.held ? turnPayloadSequence(source.held)! : null;
      if (source.kind === "dht" && condition !== null && String(heldSequence) !== condition) { results.push({ source: source.name, outcome: "refused", detail: "301" }); continue; }
      if (heldSequence !== null && sequence < heldSequence) { results.push({ source: source.name, outcome: "refused", detail: source.kind === "dht" ? "302" : "HTTP 409" }); continue; }
      if (source.kind === "relay" && heldSequence === sequence && source.held && larger(source.held, payload)) { results.push({ source: source.name, outcome: "refused", detail: "HTTP 409" }); continue; }
      if (!source.frozen) source.held = payload;
      results.push({ source: source.name, outcome: "stored" });
    }
    return results;
  }
}
