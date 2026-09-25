import type { PairedTransport } from "@ghostly/core";

/**
 * A chat's connection story: one short line in its timeline each time the live transport changes (the first
 * connection, a switch and why, a lost link and what carries text meanwhile, coming back, a switch that failed).
 *
 * Derived on each side from its own engine events; nothing goes on the wire for it (a contact's explicit choice is
 * read from the transport policy it already sends). The lines are kept on the link, not among the messages: they
 * never count as unread, never become the chat's preview, are never sent, and go when the chat goes. The app has
 * no disappearing-message timer; if it gets one, these lines follow it like any other row.
 */
export type TransportEntryKind = "connected" | "switched" | "failed" | "lost" | "back" | "flapping";
/** Why a switch happened: someone chose it, the link it replaced dropped, or the app moved on its own. */
export type TransportCause = "you" | "contact" | "dropped" | "automatic";

export interface TransportEntry {
  id: string;
  at: number;
  kind: TransportEntryKind;
  /** The transport carrying the chat after this line; absent while it is not live. */
  transport?: PairedTransport;
  /** `switched`: the one before. `lost`: the one that dropped. */
  from?: PairedTransport;
  /** `failed`: the transport it tried to move to. */
  target?: PairedTransport;
  cause?: TransportCause;
  /** `failed`: why, in the app's words. */
  reason?: string;
  /** `lost` (and a `flapping` line that ended lost): what carries text meanwhile. `dht-only`: this side chose DHT-only. */
  fallback?: "dht" | "hold" | "dht-only";
  /** Round trip measured on this transport, once known. */
  rttMs?: number;
  /** `flapping`: how many times the link came back, since when; `live`: whether it was live at the last change. */
  count?: number;
  since?: number;
  live?: boolean;
}

/** What the chat's link looks like now, as the engine sees it. */
export interface TransportSnapshot {
  live: boolean;
  transport?: PairedTransport;
  /** What carries text right now. */
  text: "stream" | "dht" | "hold" | "unavailable";
  /** This side chose DHT-only delivery. */
  dhtOnly: boolean;
  transitionError?: string;
  transitionTarget?: PairedTransport;
}

/** Changes closer together than this are one flapping line. */
export const FLAP_WINDOW_MS = 60_000;
/** Lines about the link dropping and coming back, within the window, before they become one. */
export const FLAP_MIN_LINES = 4;
/** A choice explains a switch that lands this soon after it. */
export const CHOICE_TTL_MS = 2 * 60_000;
/** Lines kept per chat. */
export const TRANSPORT_LOG_MAX = 50;

const churn = (e: TransportEntry) => e.kind === "lost" || e.kind === "back" || e.kind === "flapping" || (e.kind === "switched" && e.cause === "dropped");
const liveLine = (e: TransportEntry) => e.kind === "flapping" ? !!e.live : e.kind !== "lost" && !!e.transport;

let sequence = 0;
const lineId = (at: number) => `${at.toString(36)}-${(++sequence).toString(36)}`;

export class TransportLog {
  entries: TransportEntry[];
  private snapshot: TransportSnapshot | null = null;
  private choice: { by: "you" | "contact"; transport: PairedTransport; at: number } | null = null;

  constructor(entries: readonly TransportEntry[] = []) {
    this.entries = entries.slice(-TRANSPORT_LOG_MAX).map(e => ({ ...e }));
  }

  /** Someone chose a transport for this chat just now: a switch to it soon after is theirs. */
  chose(by: "you" | "contact", transport: PairedTransport, now: number): void {
    this.choice = { by, transport, at: now };
  }

  /** The link changed (or may have). True when a line was added or changed. */
  observe(next: TransportSnapshot, now: number): boolean {
    const prev = this.snapshot;
    this.snapshot = { ...next };
    const last = this.entries.at(-1);
    if (next.live && next.transport) {
      if (prev?.live && prev.transport === next.transport) {
        // Still on the same one: a switch that did not happen is the only news.
        if (next.transitionError && next.transitionError !== prev.transitionError)
          return this.failed(prev.transitionTarget ?? this.choice?.transport, next.transitionError, next.transport, now);
        return false;
      }
      if (prev?.live && prev.transport) return this.add({ kind: "switched", at: now, from: prev.transport, transport: next.transport, cause: this.cause(next.transport, now) ?? "automatic" });
      const wasLost = !!last && !liveLine(last);
      const before = this.lastTransport();
      if (!last || !wasLost) return this.add({ kind: "connected", at: now, transport: next.transport });
      if (before && before !== next.transport) return this.add({ kind: "switched", at: now, from: before, transport: next.transport, cause: this.cause(next.transport, now) ?? "dropped" });
      return this.add({ kind: "back", at: now, transport: next.transport });
    }
    const fallback = next.dhtOnly ? "dht-only" as const : next.text === "dht" ? "dht" as const : next.text === "hold" ? "hold" as const : undefined;
    if (prev?.live) return this.add({ kind: "lost", at: now, from: prev.transport, fallback, ...(next.dhtOnly && !prev.dhtOnly ? { cause: "you" as const } : {}) });
    // Not live before either: what carries text meanwhile may have become known since the link dropped.
    if (last && !liveLine(last) && (last.kind === "lost" || last.kind === "flapping") && last.fallback !== fallback) {
      last.fallback = fallback;
      return true;
    }
    if (next.transitionError && next.transitionError !== prev?.transitionError)
      return this.failed(prev?.transitionTarget ?? this.choice?.transport, next.transitionError, undefined, now);
    return false;
  }

  /** A round trip measured on the current transport: the line that started it shows it. */
  rtt(ms: number): boolean {
    const last = this.entries.at(-1);
    if (!last || !liveLine(last) || last.kind === "failed" || last.rttMs === ms) return false;
    last.rttMs = ms;
    return true;
  }

  private lastTransport(): PairedTransport | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.transport) return e.transport;
      if (e.from) return e.from;
    }
    return undefined;
  }

  private cause(transport: PairedTransport, now: number): TransportCause | undefined {
    const choice = this.choice;
    if (!choice || choice.transport !== transport || now - choice.at > CHOICE_TTL_MS) return undefined;
    this.choice = null;
    return choice.by;
  }

  private failed(target: PairedTransport | undefined, reason: string, transport: PairedTransport | undefined, now: number): boolean {
    const last = this.entries.at(-1);
    if (last?.kind === "failed" && last.reason === reason && last.target === target) return false;
    if (target && this.choice?.transport === target) this.choice = null;
    return this.add({ kind: "failed", at: now, target, reason, transport });
  }

  private add(line: Omit<TransportEntry, "id">): boolean {
    const entry: TransportEntry = { id: lineId(line.at), ...line };
    const tail = this.entries.at(-1);
    if (churn(entry) && tail?.kind === "flapping" && entry.at - tail.at <= FLAP_WINDOW_MS) {
      tail.at = entry.at;
      if (entry.kind === "lost") { tail.live = false; tail.from = entry.from; tail.transport = undefined; tail.fallback = entry.fallback; }
      else { tail.count = (tail.count ?? 0) + 1; tail.live = true; tail.transport = entry.transport; tail.from = undefined; tail.fallback = undefined; tail.rttMs = undefined; }
      return true;
    }
    if (churn(entry)) {
      let start = this.entries.length;
      while (start > 0 && churn(this.entries[start - 1]) && this.entries[start - 1].kind !== "flapping" && entry.at - this.entries[start - 1].at <= FLAP_WINDOW_MS) start--;
      const run = [...this.entries.slice(start), entry];
      if (run.length >= FLAP_MIN_LINES) {
        const live = entry.kind !== "lost";
        this.entries.splice(start, this.entries.length - start, {
          id: run[0].id, kind: "flapping", at: entry.at, since: run[0].at, count: run.filter(e => e.kind !== "lost").length, live,
          ...(live ? { transport: entry.transport } : { from: entry.from, fallback: entry.fallback }),
        });
        return true;
      }
    }
    this.entries.push(entry);
    if (this.entries.length > TRANSPORT_LOG_MAX) this.entries.splice(0, this.entries.length - TRANSPORT_LOG_MAX);
    return true;
  }
}
