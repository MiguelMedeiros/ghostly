import { TRANSPORTS, type PairedTransport } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import type { TransportEntry, TransportEvent } from "@ghostly/browser/engine/transportLog";
import { transportName } from "./connection";

export type { TransportEntry, TransportEvent };

const name = transportName;
const native = (t?: PairedTransport) => t === "iroh/1" || t === "hyperdht/1";

/** An error from the engine, short enough for a timeline line: transport ids named, the advice left for the details. */
export function shortReason(reason: string): string {
  let text = reason;
  for (const t of TRANSPORTS) text = text.split(t).join(name(t));
  return text
    .replace(/^Transport change failed:\s*/i, "")
    .replace(/\s*(Your previous connection is kept when available;\s*)?(Retry|retry) or choose another transport\.?$/, "")
    .replace(/\s*Retry when both peers are connected\.?$/, "")
    .trim().replace(/\.$/, "");
}

/** How long a run of changes took, as people say it. */
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** The line a transport change reads as in the chat. `contact`: the name the chat shows for the other side. */
export function transportLineText(entry: TransportEntry, contact: string): string {
  const t = name(entry.transport);
  switch (entry.kind) {
    case "connected": return `Connected over ${t}`;
    case "back":
      if (entry.downMs === undefined) return `Back live over ${t}`;
      return `Reconnected over ${t} after ${lasting(entry.downMs)}${entry.from ? ` · ${name(entry.from)} dropped` : ""}`;
    case "chose": {
      const who = entry.cause === "contact" ? contact : "You";
      if (entry.target) return `${who} chose ${name(entry.target)}`;
      const back = entry.cause === "contact" ? `${contact} went back to automatic` : "Back to automatic";
      return entry.from && entry.transport ? `${back} · now on ${t}` : back;
    }
    case "switched":
      if (entry.cause === "you") return `You switched to ${t}`;
      if (entry.cause === "contact") return `${contact} switched to ${t}`;
      if (entry.cause === "dropped") return `Switched to ${t}: ${name(entry.from)} dropped`;
      return native(entry.transport) ? `Moved to ${t}, a direct path was found` : `Moved to ${t}`;
    case "failed": {
      const reason = entry.reason ? shortReason(entry.reason) : "";
      return `Couldn't switch${entry.target ? ` to ${name(entry.target)}` : " transport"}${reason ? `: ${reason}` : ""}.${entry.transport ? ` Still on ${t}` : ""}`;
    }
    case "lost":
      if (entry.fallback === "dht-only") return entry.cause === "you" ? "You turned on DHT only · no live connection" : "DHT only · no live connection";
      if (entry.fallback === "dht") return "Live connection lost · texts go through the DHT";
      if (entry.fallback === "hold") return `Live connection lost · messages wait for ${contact}`;
      return "Live connection lost";
    // Worded as WISP 400 § "Pairing progress and transport rows" has them.
    case "dht-only": return entry.cause === "contact" ? `${contact} switched to DHT only` : "You switched to DHT only";
    case "dht-left": return "Left DHT only · connecting live";
    case "flapping": {
      const count = entry.count ?? 0;
      const times = `Reconnected ${count} ${count === 1 ? "time" : "times"} in ${span(entry.at - (entry.since ?? entry.at))}`;
      return entry.live ? `${times} · on ${t}` : `${times} · not live now`;
    }
  }
}

/** What tapping a line shows: the transport, since when, why, and the round trip if known. */
export function transportLineDetails(entry: TransportEntry, contact: string, format: (at: number) => string): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const live = entry.kind === "flapping" ? entry.live : entry.kind !== "lost" && entry.kind !== "dht-only" && entry.kind !== "dht-left" && entry.kind !== "failed" && !!entry.transport;
  rows.push({ label: "Transport", value: live ? name(entry.transport) : entry.kind === "dht-only" ? "DHT only" : "None live" });
  rows.push({ label: "Since", value: format(entry.at) });
  rows.push({ label: "Why", value: transportLineWhy(entry, contact, format) });
  if (entry.kind === "back" && entry.downMs !== undefined) rows.push({ label: "Not live for", value: lasting(entry.downMs) });
  if (entry.rttMs !== undefined && live) rows.push({ label: "Round trip", value: `${entry.rttMs} ms` });
  return rows;
}

const t = (entry: TransportEntry) => name(entry.transport);

function transportLineWhy(entry: TransportEntry, contact: string, format: (at: number) => string): string {
  switch (entry.kind) {
    case "connected": return entry.transport === "webrtc/1"
      ? "The chat opened its live connection. A first pairing always uses WebRTC."
      : "The chat opened its live connection on the transport both apps rank first.";
    case "back": {
      if (entry.downMs === undefined) return "DHT only ended, and the live connection came back.";
      const meanwhile = entry.fallback === "dht" ? " Texts went through the DHT meanwhile."
        : entry.fallback === "hold" ? ` What you sent waited in your storage for ${contact}.` : "";
      return `The live connection${entry.from ? ` over ${name(entry.from)}` : ""} ended at ${format(entry.at - entry.downMs)} and was down for ${lasting(entry.downMs)}.${meanwhile}${entry.from ? ` It came back over ${t(entry)}.` : ""}`;
    }
    case "chose": {
      const who = entry.cause === "contact" ? `${contact} chose` : "You chose";
      if (entry.target) return entry.transport === entry.target ? `${who} ${name(entry.target)} for this chat. It was already on it.`
        : `${who} ${name(entry.target)} for this chat. It moves there when both apps can reach each other over it.`;
      const back = entry.cause === "contact" ? `${contact} went back to automatic` : "You went back to automatic";
      return `${back}: the apps choose the transport again.${entry.from && entry.transport ? ` The chat moved from ${name(entry.from)} to ${t(entry)}.` : ""}`;
    }
    case "switched":
      if (entry.cause === "you") return `You chose ${name(entry.transport)} for this chat. The session moved from ${name(entry.from)} without reconnecting.`;
      if (entry.cause === "contact") return `${contact} chose ${name(entry.transport)} for this chat. The session moved from ${name(entry.from)} without reconnecting.`;
      if (entry.cause === "dropped") return `${name(entry.from)} dropped, and the chat came back over ${name(entry.transport)}.`;
      return `Both apps allow ${name(entry.transport)} and moved there by themselves, from ${name(entry.from)}.`;
    case "failed": return `${entry.reason ?? "The new transport did not connect."}${entry.transport ? ` The chat stayed on ${name(entry.transport)}.` : ""}`;
    case "lost":
      if (entry.fallback === "dht-only") return "DHT only is on: short texts go through the DHT, with no live connection.";
      if (entry.fallback === "dht") return `The live connection over ${name(entry.from)} ended. Short texts go through the DHT until it is back.`;
      if (entry.fallback === "hold") return `The live connection over ${name(entry.from)} ended. What you send waits in your storage for ${contact}.`;
      return `The live connection over ${name(entry.from)} ended. Ghostly reconnects when ${contact} is reachable.`;
    case "dht-only": return `${entry.cause === "contact" ? `${contact} chose` : "You chose"} DHT only: short texts go through the DHT, with no live connection, until you both leave it.`;
    case "dht-left": return entry.transport
      ? `DHT only ended for both of you. You chose ${name(entry.transport)} for this chat; the live connection comes back when both apps can reach each other.`
      : "DHT only ended for both of you. The apps choose the transport again; the live connection comes back when both apps can reach each other.";
    case "flapping": return `The live connection dropped and came back ${entry.count ?? 0} times between ${format(entry.since ?? entry.at)} and ${format(entry.at)}.`;
  }
}

/** How the menu lists them: the one every app has first, then the native ones. */
const MENU_ORDER: PairedTransport[] = ["webrtc/1", "iroh/1", "hyperdht/1"];

/** A transport the chat's menu offers, or why it cannot. */
export interface TransportOption {
  transport: PairedTransport;
  available: boolean;
  reason?: string;
}

/**
 * What the chat's Connection menu offers: transports this app runs and the contact's app supports on this link
 * (per its last word; unknown before a first session, then only this app's side is known). Never one this app lacks.
 */
export function transportOptions(link: Pick<LinkView, "availableTransports" | "peerTransports" | "transportErrors">): TransportOption[] {
  const mine = link.availableTransports ?? [], theirs = link.peerTransports;
  return MENU_ORDER.map(transport => {
    const error = link.transportErrors?.[transport];
    if (!mine.includes(transport)) return { transport, available: false,
      reason: error ?? (transport === "webrtc/1" ? "This app has no WebRTC" : `${name(transport)} needs Ghostly Desktop`) };
    if (theirs && !theirs.includes(transport)) return { transport, available: false, reason: `Your contact's app doesn't support ${name(transport)}` };
    return { transport, available: true };
  });
}

export type TimelineRow<M> = { kind: "message"; message: M } | { kind: "transport"; entry: TransportEntry; earlier: TransportEntry[] };

/**
 * Messages and the chat's transport rows in one timeline, by time. Rows with no message between them are one row:
 * the latest, with the ones before it in `earlier` (its details list them), so the timeline never shows a column
 * of them. A legacy flapping row stays where it began.
 */
export function mergeTimeline<M extends { timestamp: number }>(messages: readonly M[], lines: readonly TransportEntry[]): TimelineRow<M>[] {
  const at = (e: TransportEntry) => e.since ?? e.at;
  const sorted = [...lines].sort((a, b) => at(a) - at(b));
  const out: TimelineRow<M>[] = [];
  let i = 0;
  const rows = (until: number) => {
    const run: TransportEntry[] = [];
    while (i < sorted.length && at(sorted[i]) <= until) run.push(sorted[i++]);
    if (run.length) out.push({ kind: "transport", entry: run[run.length - 1], earlier: run.slice(0, -1) });
  };
  for (const message of messages) {
    rows(message.timestamp);
    out.push({ kind: "message", message });
  }
  rows(Infinity);
  return out;
}

/** How long, to the second when short: the connection history is about exact moments. */
function duration(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1_000))} s` : lasting(ms);
}

/** One event of the connection panel's history, in a line. */
export function transportEventText(event: TransportEvent, contact: string): string {
  const t = name(event.transport), rtt = event.rttMs !== undefined ? ` · ${event.rttMs} ms` : "";
  switch (event.kind) {
    case "live": {
      const how = event.started ? " · this app started" : event.downMs !== undefined ? ` · after ${duration(event.downMs)} down` : "";
      return `Live over ${t}${event.from ? ` (was ${name(event.from)})` : ""}${how}${rtt}`;
    }
    case "down":
      return `Live connection lost${event.from ? ` (${name(event.from)})` : ""}${event.text === "dht" ? " · texts go through the DHT" : event.text === "hold" ? ` · messages wait for ${contact}` : ""}${event.reason ? ` · ${event.reason}` : ""}`;
    case "switched": {
      const why = event.cause === "you" ? "your choice" : event.cause === "contact" ? `${contact}'s choice` : event.cause === "dropped" ? "after a drop" : "automatic";
      return `Moved from ${name(event.from)} to ${t} · ${why}${rtt}`;
    }
    case "chose": {
      const who = event.cause === "contact" ? contact : "You";
      return event.target ? `${who} chose ${name(event.target)}` : event.cause === "contact" ? `${contact} went back to automatic` : "You went back to automatic";
    }
    case "failed": {
      const reason = event.reason ? shortReason(event.reason) : "";
      return `Couldn't switch${event.target ? ` to ${name(event.target)}` : " transport"}${reason ? `: ${reason}` : ""}`;
    }
    case "attempt": return `Connection attempt failed${event.reason ? `: ${shortReason(event.reason)}` : ""}`;
    case "dht-only": return event.cause === "contact" ? `${contact} switched to DHT only` : "You switched to DHT only";
    case "dht-left": return `Left DHT only${event.transport ? ` · set to ${t}` : " · automatic"}`;
  }
}

/** The live transport of a chat: on it, and nothing moving. */
export function liveTransport(link?: Pick<LinkView, "dataLink" | "pairing" | "deliveryMode">): PairedTransport | undefined {
  const pair = link?.pairing;
  return link?.dataLink === "open" && pair?.status === "ready" && link.deliveryMode !== "dht" ? pair.transport : undefined;
}

/** How long something has lasted, as a person says it: "less than a minute", "12 min", "3 h", "2 days". */
export function lasting(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** What a chat's live connection is, at a glance: the tooltip, the ⋮ row and the popover all read from this. */
export interface ConnectionSummary {
  transport: PairedTransport;
  name: string;
  rttMs?: number;
  since?: number;
  /** Relayed (WISP 100): the relays' hosts. Absent on a direct path. */
  relays?: string[];
  /** Why this transport, in a few words ("your choice") and in a sentence. */
  whyShort: string;
  why: string;
  /** "Iroh · 42 ms · live for 12 min · your choice" */
  line: string;
  /** Short enough for a menu row's second line: "Iroh · 42 ms · your choice". */
  short: string;
  /** The same without the transport's name, under a label that already says it: "42 ms · live for 12 min · your choice". */
  detail: string;
}

export function connectionSummary(link: LinkView | undefined, now: number, contact = "Your contact"): ConnectionSummary | undefined {
  const transport = liveTransport(link);
  if (!link || !transport) return undefined;
  const t = name(transport), chosen = link.transportAutomatic === false || (link.transportAutomatic === undefined && link.preferredTransport !== undefined);
  const cause = link.transportLive?.cause, only = (link.availableTransports ?? []).length === 1;
  const relayed = link.transportRelayed;
  const [whyShort, why] = only ? ["the only one here", `${t} is the only transport this app runs.`]
    : cause === "contact" ? [`${contact === "Your contact" ? "your contact's" : `${contact}'s`} choice`, `${contact} chose ${t} for this chat.`]
    : chosen && link.preferredTransport === transport ? ["your choice", `You chose ${t} for this chat.`]
    : chosen ? ["fallback", `You chose ${name(link.preferredTransport)} for this chat; it is not available now, so the chat uses ${t}.`]
    : cause === "dropped" ? ["automatic, after a drop", `Automatic: the chat came back over ${t} after the previous transport dropped.`]
    : relayed ? ["no direct path", `Automatic: a direct connection could not be made, so the chat goes through ${t}'s relay.`]
    : ["automatic", `Automatic: both apps rank ${t} first${transport === "webrtc/1" ? ", and a first pairing always uses WebRTC" : ""}.`];
  const since = link.transportLive?.since;
  const rtt = link.transportRttMs !== undefined ? [`${link.transportRttMs} ms`] : [];
  const path = relayed ? ["relayed"] : [];
  const parts = [...path, ...rtt, ...(since !== undefined ? [`live for ${lasting(now - since)}`] : []), whyShort];
  return { transport, name: t, rttMs: link.transportRttMs, since, relays: relayed?.relays, whyShort,
    why: relayed ? `${why} Relayed: ${relayed.relays.join(" and ") || "a relay"} sees which devices talk and when, never what they say.` : why,
    line: [t, ...parts].join(" · "), detail: parts.join(" · "), short: [t, ...path, ...rtt, whyShort].join(" · ") };
}

