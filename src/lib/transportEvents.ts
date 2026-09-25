import { TRANSPORTS, type PairedTransport } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import type { TransportEntry } from "@ghostly/browser/engine/transportLog";
import { transportName } from "./connection";

export type { TransportEntry };

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
    case "back": return `Back live over ${t}`;
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
    case "dht-only": return entry.cause === "contact" ? `${contact} chose DHT only` : "You chose DHT only";
    case "dht-left": return entry.transport ? `Left DHT only · ${t} chosen` : "Back to automatic";
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
  const live = entry.kind === "flapping" ? entry.live : entry.kind !== "lost" && entry.kind !== "dht-only" && entry.kind !== "dht-left" && !!entry.transport;
  rows.push({ label: "Transport", value: live ? name(entry.transport) : entry.kind === "dht-only" ? "DHT only" : "None live" });
  rows.push({ label: "Since", value: format(entry.at) });
  rows.push({ label: "Why", value: transportLineWhy(entry, contact, format) });
  if (entry.rttMs !== undefined && live) rows.push({ label: "Round trip", value: `${entry.rttMs} ms` });
  return rows;
}

function transportLineWhy(entry: TransportEntry, contact: string, format: (at: number) => string): string {
  switch (entry.kind) {
    case "connected": return entry.transport === "webrtc/1"
      ? "The chat opened its live connection. A first pairing always uses WebRTC."
      : "The chat opened its live connection on the transport both apps rank first.";
    case "back": return `The live connection came back on the same transport.`;
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

/** Messages and the chat's transport lines in one timeline, by time. A flapping line stays where it began. */
export function mergeTimeline<M extends { timestamp: number }>(messages: readonly M[], lines: readonly TransportEntry[]):
  ({ kind: "message"; message: M } | { kind: "transport"; entry: TransportEntry })[] {
  const sorted = [...lines].sort((a, b) => (a.since ?? a.at) - (b.since ?? b.at));
  const out: ({ kind: "message"; message: M } | { kind: "transport"; entry: TransportEntry })[] = [];
  let i = 0;
  for (const message of messages) {
    while (i < sorted.length && (sorted[i].since ?? sorted[i].at) <= message.timestamp) out.push({ kind: "transport", entry: sorted[i++] });
    out.push({ kind: "message", message });
  }
  while (i < sorted.length) out.push({ kind: "transport", entry: sorted[i++] });
  return out;
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
  const [whyShort, why] = only ? ["the only one here", `${t} is the only transport this app runs.`]
    : cause === "contact" ? [`${contact === "Your contact" ? "your contact's" : `${contact}'s`} choice`, `${contact} chose ${t} for this chat.`]
    : chosen && link.preferredTransport === transport ? ["your choice", `You chose ${t} for this chat.`]
    : chosen ? ["fallback", `You chose ${name(link.preferredTransport)} for this chat; it is not available now, so the chat uses ${t}.`]
    : cause === "dropped" ? ["automatic, after a drop", `Automatic: the chat came back over ${t} after the previous transport dropped.`]
    : ["automatic", `Automatic: both apps rank ${t} first${transport === "webrtc/1" ? ", and a first pairing always uses WebRTC" : ""}.`];
  const since = link.transportLive?.since;
  const parts = [...(link.transportRttMs !== undefined ? [`${link.transportRttMs} ms`] : []), ...(since !== undefined ? [`live for ${lasting(now - since)}`] : []), whyShort];
  return { transport, name: t, rttMs: link.transportRttMs, since, whyShort, why, line: [t, ...parts].join(" · "), detail: parts.join(" · "),
    short: [t, ...(link.transportRttMs !== undefined ? [`${link.transportRttMs} ms`] : []), whyShort].join(" · ") };
}

