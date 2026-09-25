import type { PairedTransport } from "@ghostly/core";

/**
 * A chat's connection story, in two places (WISP 400 § "Pairing progress and transport rows").
 *
 * - **Rows** (`entries`), in the chat's timeline, for what matters to the people in it: the first live connection,
 *   the transport actually changing, someone's choice, a switch that failed, and a real outage (one row, when it
 *   ends). An app restart or a short drop that comes back on the same transport is not a row.
 * - **History** (`history`), in the connection panel: every event, drops, restarts, failed attempts and round trips
 *   included, so nothing is lost by keeping the timeline quiet.
 *
 * Derived on each side from its own engine events; nothing goes on the wire for it (a contact's explicit choice is
 * read from the transport policy it already sends). Both are kept on the link, not among the messages: they never
 * count as unread, never become the chat's preview, are never sent, and go when the chat goes.
 */
export type TransportEntryKind = "connected" | "switched" | "chose" | "failed" | "back" | "dht-only" | "dht-left"
  /** Written by older releases only; compacted away on load (`compactTransportRows`). */
  | "lost" | "flapping";
/** Why a switch happened: someone chose it, the link it replaced dropped, or the app moved on its own. */
export type TransportCause = "you" | "contact" | "dropped" | "automatic";

export interface TransportEntry {
  id: string;
  at: number;
  kind: TransportEntryKind;
  /**
   * The transport carrying the chat after this row; absent while it is not live. `dht-left`: the transport the
   * chat is set to from now on, absent when back to automatic. `chose`: where the chat is live, if it is.
   */
  transport?: PairedTransport;
  /** `switched`: the one before. `back`: the one that dropped, when the chat came back on another. */
  from?: PairedTransport;
  /** `failed`: the transport it tried to move to. `chose`: the one chosen; absent: back to automatic. */
  target?: PairedTransport;
  cause?: TransportCause;
  /** `failed`: why, in the app's words. */
  reason?: string;
  /** `back` after an outage: what carried text meanwhile. `dht-only`: this side chose DHT only. */
  fallback?: "dht" | "hold" | "dht-only";
  /** `back`: how long the chat had no live connection. */
  downMs?: number;
  /** The transport carrying the chat after this line goes through a relay (WISP 100: a fallback, never first). */
  relayed?: boolean;
  /** Round trip measured on this transport, once known. */
  rttMs?: number;
  /** Legacy `flapping` rows: how many times the link came back, since when, and whether it was live at the end. */
  count?: number;
  since?: number;
  live?: boolean;
}

/** One event in the connection panel's history: everything, including what the timeline leaves out. */
export type TransportEventKind = "live" | "down" | "switched" | "chose" | "failed" | "attempt" | "dht-only" | "dht-left";

export interface TransportEvent {
  at: number;
  kind: TransportEventKind;
  transport?: PairedTransport;
  from?: PairedTransport;
  target?: PairedTransport;
  cause?: TransportCause;
  /** `failed`, `attempt`: why. */
  reason?: string;
  /** `down`: what carries text meanwhile. */
  text?: "dht" | "hold";
  /** `live`: how long the chat had no live connection before it (unknown after this app started). */
  downMs?: number;
  /** `live`: the first live connection since this app started. */
  started?: boolean;
  /** `live`, `switched`: the latest round trip measured on it. */
  rttMs?: number;
}

/** What the chat's link looks like now, as the engine sees it. */
export interface TransportSnapshot {
  live: boolean;
  transport?: PairedTransport;
  /** `transport` goes through a relay. */
  relayed?: boolean;
  /** What carries text right now. */
  text: "stream" | "dht" | "hold" | "unavailable";
  /** This side chose DHT-only delivery. */
  dhtOnly: boolean;
  /** The contact chose DHT-only delivery (its DHT envelope's `mode`): no live link either way until both leave it. */
  peerDhtOnly?: boolean;
  /** The transport this chat is set to; absent: automatic. */
  preferred?: PairedTransport;
  transitionError?: string;
  transitionTarget?: PairedTransport;
  /** Why the last attempt to connect failed, while not live. */
  error?: string;
}

/** A drop the chat comes back from this soon, on the same transport, is not a row. */
export const QUIET_DROP_MS = 5 * 60_000;
/** A choice explains a switch that lands this soon after it. */
export const CHOICE_TTL_MS = 2 * 60_000;
/** Rows kept per chat. */
export const TRANSPORT_LOG_MAX = 50;
/** History events kept per chat. */
export const TRANSPORT_HISTORY_MAX = 200;
/** A round trip that moved less than this is not news in the history. */
const RTT_STEP_MS = 10;

let sequence = 0;
const lineId = (at: number) => `${at.toString(36)}-${(++sequence).toString(36)}`;

/** A row that says the chat is live on its transport from then on. */
const liveRow = (e: TransportEntry) => e.kind === "flapping" ? !!e.live
  : e.kind !== "lost" && e.kind !== "dht-only" && e.kind !== "dht-left" && e.kind !== "failed" && !!e.transport;

/**
 * Rows written by older releases, by today's rules: a restart or a short drop on the same transport goes, a
 * "lost" row goes (a long outage becomes one "back" row with how long it lasted), and a flapping run becomes what
 * it ended on. Rows of today's rules pass unchanged.
 */
export function compactTransportRows(rows: readonly TransportEntry[]): TransportEntry[] {
  const out: TransportEntry[] = [];
  let logged: PairedTransport | undefined;
  let down: { at: number; from?: PairedTransport; fallback?: TransportEntry["fallback"] } | null = null;
  let dhtLeft = false;
  const push = (e: TransportEntry) => { out.push(e); if (liveRow(e)) logged = e.transport; };
  /** The chat came back live on `transport` at `at`: a row only if that is news. */
  const cameBack = (e: TransportEntry, transport: PairedTransport, at: number) => {
    const gap = down ? at - down.at : undefined, fallback = down?.fallback === "dht" || down?.fallback === "hold" ? down.fallback : undefined;
    down = null;
    if (dhtLeft) { dhtLeft = false; return push({ id: e.id, at, kind: "back", transport, ...(e.rttMs !== undefined ? { rttMs: e.rttMs } : {}) }); }
    if (!logged) return push({ id: e.id, at, kind: "connected", transport });
    const moved = logged !== transport;
    if (gap !== undefined && gap > QUIET_DROP_MS)
      return push({ id: e.id, at, kind: "back", transport, downMs: gap, ...(moved ? { from: logged } : {}), ...(fallback ? { fallback } : {}), ...(e.rttMs !== undefined ? { rttMs: e.rttMs } : {}) });
    if (moved) push({ id: e.id, at, kind: "switched", from: logged, transport, cause: gap === undefined ? "automatic" : "dropped", ...(e.rttMs !== undefined ? { rttMs: e.rttMs } : {}) });
  };
  for (const e of rows) {
    if (e.kind === "lost") { if (!down) down = { at: e.at, from: e.from, fallback: e.fallback }; continue; }
    if (e.kind === "flapping") {
      // It ended live on a transport, or down since its last change.
      if (e.live && e.transport) { if (!down) down = { at: e.since ?? e.at }; cameBack(e, e.transport, e.at); }
      else if (!down) down = { at: e.at, from: e.from, fallback: e.fallback };
      continue;
    }
    if (e.kind === "connected" && e.transport) { if (!logged) push({ ...e }); else { down = null; cameBack(e, e.transport, e.at); } continue; }
    if (e.kind === "back" && e.transport) { if (e.downMs !== undefined) { down = null; push({ ...e }); } else cameBack(e, e.transport, e.at); continue; }
    if (e.kind === "switched" && e.cause === "dropped" && e.transport) { if (!down) down = { at: e.at }; cameBack(e, e.transport, e.at); continue; }
    if (e.kind === "dht-only") down = null;
    if (e.kind === "dht-left") dhtLeft = true;
    push({ ...e });
  }
  return out.slice(-TRANSPORT_LOG_MAX);
}

/** The history an older release left no room for: its rows, as events. */
function historyFromRows(rows: readonly TransportEntry[]): TransportEvent[] {
  const events: TransportEvent[] = [];
  for (const e of rows) {
    const base = { at: e.at, ...(e.transport ? { transport: e.transport } : {}), ...(e.from ? { from: e.from } : {}), ...(e.cause ? { cause: e.cause } : {}), ...(e.rttMs !== undefined ? { rttMs: e.rttMs } : {}) };
    if (e.kind === "lost") events.push({ ...base, kind: "down", ...(e.fallback === "dht" || e.fallback === "hold" ? { text: e.fallback } : {}) });
    else if (e.kind === "flapping") events.push({ ...base, kind: e.live ? "live" : "down", reason: `Dropped and came back ${e.count ?? 0} times` });
    else if (e.kind === "connected" || e.kind === "back") events.push({ ...base, kind: "live", ...(e.downMs !== undefined ? { downMs: e.downMs } : {}) });
    else if (e.kind === "failed") events.push({ ...base, kind: "failed", ...(e.target ? { target: e.target } : {}), ...(e.reason ? { reason: e.reason } : {}) });
    else if (e.kind === "chose") events.push({ ...base, kind: "chose", ...(e.target ? { target: e.target } : {}) });
    else events.push({ ...base, kind: e.kind });
  }
  return events;
}

export class TransportLog {
  entries: TransportEntry[];
  history: TransportEvent[];
  /** Loading rewrote rows an older release stored (or seeded the history from them): worth saving as is. */
  readonly compacted: boolean;
  private snapshot: TransportSnapshot | null = null;
  private choice: { by: "you" | "contact"; transport: PairedTransport; at: number } | null = null;
  /** Since when the chat has no live connection (a drop seen by this app, not a restart of it). */
  private down: { at: number; from?: PairedTransport; text?: "dht" | "hold" } | null = null;
  /** A fresh "back to automatic" row: the automatic move it causes is told on that row. */
  private autoRow: { id: string; at: number } | null = null;
  /** Since when the current transport carries the chat, in this run of the app. */
  private liveSince?: number;
  private seenLive = false;

  constructor(entries: readonly TransportEntry[] = [], history?: readonly TransportEvent[]) {
    const compact = compactTransportRows(entries);
    this.entries = compact.map(e => ({ ...e }));
    this.history = history ? history.slice(-TRANSPORT_HISTORY_MAX).map(e => ({ ...e })) : historyFromRows(entries).slice(-TRANSPORT_HISTORY_MAX);
    this.compacted = (!history && entries.length > 0)
      || compact.length !== entries.length || compact.some((e, i) => e.id !== entries[i].id || e.kind !== entries[i].kind);
  }

  /**
   * Someone chose a transport for this chat just now (`automatic`: back to the app's rule). Always a row; a live
   * switch to it soon after turns that row into the switch. Choosing the one already carrying the chat moves
   * nothing, so there is nothing for it to explain later.
   */
  chose(by: "you" | "contact", transport: PairedTransport | "automatic", now: number): boolean {
    const on = this.snapshot?.live ? this.snapshot.transport : undefined;
    const target = transport === "automatic" ? undefined : transport;
    this.event({ at: now, kind: "chose", cause: by, ...(target ? { target } : {}), ...(on ? { transport: on } : {}) });
    this.choice = !target || target === on ? null : { by, transport: target, at: now };
    // Leaving DHT only for this choice: the row that says so already names it.
    const last = this.entries[this.entries.length - 1] as TransportEntry | undefined;
    if (last?.kind === "dht-left" && last.transport === target && now - last.at <= CHOICE_TTL_MS) return true;
    const row = this.add({ kind: "chose", at: now, cause: by, ...(target ? { target } : {}), ...(on ? { transport: on } : {}) });
    // Back to automatic may move the chat: the same row says where it landed.
    this.autoRow = target ? null : { id: row.id, at: now };
    return true;
  }

  /** The link changed (or may have). True when a row or the history changed. */
  observe(next: TransportSnapshot, now: number): boolean {
    const prev = this.snapshot;
    this.snapshot = { ...next };
    const last = this.entries[this.entries.length - 1] as TransportEntry | undefined;
    // DHT only (WISP 400): either side choosing it keeps both off the live link; each choice, and the way out, is a row.
    const dhtBefore = prev ? prev.dhtOnly || !!prev.peerDhtOnly : last?.kind === "dht-only";
    const dhtNow = next.dhtOnly || !!next.peerDhtOnly;
    if (dhtNow) {
      const you = next.dhtOnly && !(prev ? prev.dhtOnly : dhtBefore);
      const contact = !!next.peerDhtOnly && !(prev ? prev.peerDhtOnly : dhtBefore);
      if (!you && !contact) return false;
      // The choice is the reason the link went: no outage to tell when it comes back.
      this.down = null; this.liveSince = undefined;
      const from = prev?.live ? prev.transport : undefined;
      for (const cause of [...(you ? ["you" as const] : []), ...(contact ? ["contact" as const] : [])]) {
        this.add({ kind: "dht-only", at: now, cause, ...(from ? { from } : {}) });
        this.event({ at: now, kind: "dht-only", cause, ...(from ? { from } : {}) });
      }
      return true;
    }
    if (dhtBefore) {
      this.add({ kind: "dht-left", at: now, transport: next.preferred });
      this.event({ at: now, kind: "dht-left", ...(next.preferred ? { transport: next.preferred } : {}) });
      if (next.live && next.transport) this.cameBack(next.transport, now);
      return true;
    }
    if (next.live && next.transport) {
      if (prev?.live && prev.transport === next.transport) {
        // Still on the same one: a switch that did not happen is the only news.
        if (next.transitionError && next.transitionError !== prev.transitionError)
          return this.failed(prev.transitionTarget ?? this.choice?.transport, next.transitionError, next.transport, now);
        return false;
      }
      if (prev?.live && prev.transport) return this.switched(prev.transport, next.transport, now);
      return this.cameBack(next.transport, now);
    }
    let changed = false;
    if (prev?.live) {
      // Not a row: the header says the chat is off live; a row comes only if the outage lasts (`cameBack`).
      const text = next.text === "dht" ? "dht" as const : next.text === "hold" ? "hold" as const : undefined;
      this.down = { at: now, from: prev.transport, ...(text ? { text } : {}) };
      this.liveSince = undefined;
      this.event({ at: now, kind: "down", ...(prev.transport ? { from: prev.transport } : {}), ...(text ? { text } : {}) });
      changed = true;
    } else if (this.down && prev) {
      // What carries text meanwhile may have become known since the link dropped.
      const text = next.text === "dht" ? "dht" as const : next.text === "hold" ? "hold" as const : undefined;
      if (text && text !== this.down.text) {
        this.down.text = text;
        const drop = this.lastEvent("down");
        if (drop) drop.text = text;
        changed = true;
      }
    }
    if (next.error && next.error !== prev?.error) { this.event({ at: now, kind: "attempt", reason: next.error }); changed = true; }
    if (next.transitionError && next.transitionError !== prev?.transitionError)
      return this.failed(prev?.transitionTarget ?? this.choice?.transport, next.transitionError, undefined, now) || changed;
    return changed;
  }

  /** The live transport now: since when it carries the chat and why it was chosen (the last row about it). */
  liveNow(): { since: number; cause?: TransportCause } | undefined {
    if (!this.snapshot?.live || !this.snapshot.transport || this.liveSince === undefined) return undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === "failed") continue;
      if (e.kind === "chose" && e.transport !== this.snapshot.transport) continue;
      if (!liveRow(e) || e.transport !== this.snapshot.transport) break;
      return { since: this.liveSince, cause: e.kind === "chose" ? undefined : e.kind === "back" && e.from ? "dropped" : e.cause };
    }
    return { since: this.liveSince };
  }

  /** A switch to `target` could not connect, and the chat stayed on the transport it was on. */
  switchFailed(target: PairedTransport, reason: string, now: number): boolean {
    return this.failed(target, reason, this.snapshot?.live ? this.snapshot.transport : undefined, now);
  }

  /**
   * A round trip measured on the current transport: the history keeps the latest for the stretch it belongs to,
   * and the row that started that transport shows it. True when either changed enough to keep.
   */
  rtt(ms: number): boolean {
    const on = this.snapshot?.live ? this.snapshot.transport : undefined;
    if (!on) return false;
    let changed = false;
    const last = this.entries[this.entries.length - 1] as TransportEntry | undefined;
    if (last && liveRow(last) && last.transport === on && last.rttMs === undefined) { last.rttMs = ms; changed = true; }
    const stretch = [...this.history].reverse().find(e => e.kind === "live" || e.kind === "switched" || e.kind === "down");
    if (stretch && stretch.kind !== "down" && stretch.transport === on && (stretch.rttMs === undefined || Math.abs(stretch.rttMs - ms) >= RTT_STEP_MS)) {
      stretch.rttMs = ms; changed = true;
    }
    return changed;
  }

  /** Live over `transport` again after not being live (a drop, a restart of this app, or the end of DHT only). */
  private cameBack(transport: PairedTransport, now: number): boolean {
    const down = this.down, started = !this.seenLive;
    this.down = null; this.liveSince = now; this.seenLive = true;
    const gap = down ? now - down.at : undefined;
    this.event({ at: now, kind: "live", transport, ...(down?.from && down.from !== transport ? { from: down.from } : {}), ...(gap !== undefined ? { downMs: gap } : {}), ...(started ? { started: true } : {}) });
    // Back after a drop is the app reconnecting, never someone's switch, even when it lands where someone chose:
    // that choice is spent.
    if (this.choice?.transport === transport) this.choice = null;
    const last = this.entries[this.entries.length - 1] as TransportEntry | undefined;
    if (last?.kind === "dht-left") { this.add({ kind: "back", at: now, transport }); return true; }
    const before = this.lastTransport();
    if (!before) { this.add({ kind: "connected", at: now, transport }); return true; }
    if (gap !== undefined && gap > QUIET_DROP_MS) {
      const fallback = down?.text;
      this.add({ kind: "back", at: now, transport, downMs: gap, ...(before !== transport ? { from: before } : {}), ...(fallback ? { fallback } : {}) });
      return true;
    }
    // A short drop, or this app starting: news only if the chat is on another transport than its last row says.
    if (before === transport) return true;
    this.add({ kind: "switched", at: now, from: before, transport, cause: gap === undefined ? "automatic" : "dropped" });
    return true;
  }

  /** A live session moved from one transport to another without dropping. */
  private switched(from: PairedTransport, transport: PairedTransport, now: number): boolean {
    this.liveSince = now;
    const cause = this.cause(transport, now) ?? "automatic";
    this.event({ at: now, kind: "switched", from, transport, cause });
    // The row of the choice becomes the switch it caused, or the automatic row says where it landed.
    const last = this.entries[this.entries.length - 1] as TransportEntry | undefined;
    if (last && (cause === "you" || cause === "contact") && last.kind === "chose" && last.target === transport) {
      Object.assign(last, { kind: "switched", from, transport, at: now });
      delete last.target;
      return true;
    }
    if (last && this.autoRow?.id === last.id && now - this.autoRow.at <= CHOICE_TTL_MS && cause === "automatic") {
      Object.assign(last, { from, transport });
      this.autoRow = null;
      return true;
    }
    this.add({ kind: "switched", at: now, from, transport, cause });
    return true;
  }

  private lastTransport(): PairedTransport | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      // A chosen transport is not a live one; a choice's row and a failed switch name where the chat was.
      if (e.kind === "dht-left") continue;
      if (e.transport) return e.transport;
      if (e.from) return e.from;
    }
    return undefined;
  }

  private lastEvent(kind: TransportEventKind): TransportEvent | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].kind === kind) return this.history[i];
    return undefined;
  }

  private cause(transport: PairedTransport, now: number): TransportCause | undefined {
    const choice = this.choice;
    if (!choice || choice.transport !== transport || now - choice.at > CHOICE_TTL_MS) return undefined;
    this.choice = null;
    return choice.by;
  }

  private failed(target: PairedTransport | undefined, reason: string, transport: PairedTransport | undefined, now: number): boolean {
    const last = this.entries[this.entries.length - 1] as TransportEntry | undefined;
    if (last?.kind === "failed" && last.reason === reason && last.target === target) return false;
    if (target && this.choice?.transport === target) this.choice = null;
    this.add({ kind: "failed", at: now, target, reason, transport });
    this.event({ at: now, kind: "failed", reason, ...(target ? { target } : {}), ...(transport ? { transport } : {}) });
    return true;
  }

  private event(event: TransportEvent): void {
    this.history.push(event);
    if (this.history.length > TRANSPORT_HISTORY_MAX) this.history.splice(0, this.history.length - TRANSPORT_HISTORY_MAX);
  }

  private add(line: Omit<TransportEntry, "id">): TransportEntry {
    const relayed = !!line.transport && line.transport === this.snapshot?.transport && !!this.snapshot?.relayed;
    const entry: TransportEntry = { id: lineId(line.at), ...line, ...(relayed ? { relayed } : {}) };
    this.entries.push(entry);
    if (this.entries.length > TRANSPORT_LOG_MAX) this.entries.splice(0, this.entries.length - TRANSPORT_LOG_MAX);
    return entry;
  }
}
