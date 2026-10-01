import { TRANSPORTS, type IdentityTimelineEntry, type LiveAttempt, type PairedTransport, type TransportWait } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import type { TransportEntry, TransportEvent } from "@ghostly/browser/engine/transportLog";
import { transportName } from "./connection";
import { englishT, type Translate } from "../locales/translate";

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
function span(ms: number, tr: Translate): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? tr("connection.duration.minutes", { n: minutes }) : tr("connection.duration.hours", { n: Math.round(minutes / 60) });
}

/** "Couldn't switch to Iroh: it timed out": the head of a failed switch, with the engine's reason when there is one. */
function couldNotSwitch(target: PairedTransport | undefined, reason: string | undefined, tr: Translate): string {
  const head = target ? tr("connection.line.failTo", { target: name(target) }) : tr("connection.line.failAny");
  const short = reason ? shortReason(reason) : "";
  return short ? tr("connection.line.withReason", { text: head, reason: short }) : head;
}

/** The line a transport change reads as in the chat. `contact`: the name the chat shows for the other side. */
export function transportLineText(entry: TransportEntry, contact: string, tr: Translate = englishT): string {
  const transport = name(entry.transport);
  switch (entry.kind) {
    case "connected": return tr("connection.line.connected", { transport });
    case "back":
      if (entry.downMs === undefined) return tr("connection.line.backLive", { transport });
      return entry.from ? tr("connection.line.reconnectedDropped", { transport, time: lasting(entry.downMs, tr), from: name(entry.from) })
        : tr("connection.line.reconnected", { transport, time: lasting(entry.downMs, tr) });
    case "chose": {
      if (entry.target) return entry.cause === "contact" ? tr("connection.line.contactChose", { contact, transport: name(entry.target) }) : tr("connection.line.youChose", { transport: name(entry.target) });
      const now = !!(entry.from && entry.transport);
      if (entry.cause === "contact") return now ? tr("connection.line.contactBackAutoNow", { contact, transport }) : tr("connection.line.contactBackAuto", { contact });
      return now ? tr("connection.line.backAutoNow", { transport }) : tr("connection.line.backAuto");
    }
    case "switched":
      if (entry.cause === "you") return tr("connection.line.youSwitched", { transport });
      if (entry.cause === "contact") return tr("connection.line.contactSwitched", { contact, transport });
      if (entry.cause === "dropped") return tr("connection.line.switchedDropped", { transport, from: name(entry.from) });
      if (entry.relayed) return tr("connection.line.movedRelay", { transport });
      return native(entry.transport) ? tr("connection.line.movedDirect", { transport }) : tr("connection.line.moved", { transport });
    case "failed": {
      const text = couldNotSwitch(entry.target, entry.reason, tr);
      return entry.transport ? tr("connection.line.failedStill", { text, transport }) : tr("connection.line.failed", { text });
    }
    case "lost":
      if (entry.fallback === "dht-only") return entry.cause === "you" ? tr("connection.line.youDhtOnlyOn") : tr("connection.line.dhtOnlyNoLive");
      if (entry.fallback === "dht") return tr("connection.line.lostDht");
      if (entry.fallback === "hold") return tr("connection.line.lostHold", { contact });
      return tr("connection.line.lost");
    // Worded as WISP 400 § "Pairing progress and transport rows" has them.
    case "dht-only": return entry.cause === "contact" ? tr("connection.line.contactDhtOnly", { contact }) : tr("connection.line.youDhtOnly");
    case "dht-left": return tr("connection.line.dhtLeft");
    case "flapping": {
      const count = entry.count ?? 0, within = span(entry.at - (entry.since ?? entry.at), tr);
      const times = count === 1 ? tr("connection.line.reconnectedOnce", { span: within }) : tr("connection.line.reconnectedTimes", { count, span: within });
      return entry.live ? tr("connection.line.flapLive", { text: times, transport }) : tr("connection.line.flapNotLive", { text: times });
    }
  }
}

/** What tapping a line shows: the transport, since when, why, and the round trip if known. */
export function transportLineDetails(entry: TransportEntry, contact: string, format: (at: number) => string, tr: Translate = englishT): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const live = entry.kind === "flapping" ? entry.live : entry.kind !== "lost" && entry.kind !== "dht-only" && entry.kind !== "dht-left" && entry.kind !== "failed" && !!entry.transport;
  rows.push({ label: tr("connection.detail.transport"), value: live ? (entry.relayed ? tr("connection.detail.relayedOn", { transport: name(entry.transport) }) : name(entry.transport))
    : entry.kind === "dht-only" ? tr("connection.dhtOnly") : tr("connection.detail.noneLive") });
  rows.push({ label: tr("connection.detail.since"), value: format(entry.at) });
  rows.push({ label: tr("connection.detail.why"), value: transportLineWhy(entry, contact, format, tr) });
  if (entry.kind === "back" && entry.downMs !== undefined) rows.push({ label: tr("connection.detail.notLiveFor"), value: lasting(entry.downMs, tr) });
  if (entry.rttMs !== undefined && live) rows.push({ label: tr("connection.detail.roundTrip"), value: tr("connection.ms", { ms: entry.rttMs }) });
  return rows;
}

function transportLineWhy(entry: TransportEntry, contact: string, format: (at: number) => string, tr: Translate): string {
  const transport = name(entry.transport), from = name(entry.from);
  const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");
  switch (entry.kind) {
    case "connected": return entry.transport === "webrtc/1" ? tr("connection.why.connectedWebrtc") : tr("connection.why.connected");
    case "back": {
      if (entry.downMs === undefined) return tr("connection.why.backDhtEnded");
      const when = { time: format(entry.at - entry.downMs), duration: lasting(entry.downMs, tr) };
      return join(entry.from ? tr("connection.why.backOver", { ...when, from }) : tr("connection.why.back", when),
        entry.fallback === "dht" && tr("connection.why.meanwhileDht"), entry.fallback === "hold" && tr("connection.why.meanwhileHold", { contact }),
        !!entry.from && tr("connection.why.cameBack", { transport }));
    }
    case "chose": {
      if (entry.target) {
        const target = name(entry.target), already = entry.transport === entry.target;
        if (entry.cause === "contact") return already ? tr("connection.why.contactChoseAlready", { contact, transport: target }) : tr("connection.why.contactChoseMoves", { contact, transport: target });
        return already ? tr("connection.why.youChoseAlready", { transport: target }) : tr("connection.why.youChoseMoves", { transport: target });
      }
      return join(entry.cause === "contact" ? tr("connection.why.contactBackAuto", { contact }) : tr("connection.why.youBackAuto"),
        !!(entry.from && entry.transport) && tr("connection.why.movedFromTo", { from, transport }));
    }
    case "switched":
      if (entry.cause === "you") return tr("connection.why.youSwitched", { transport, from });
      if (entry.cause === "contact") return tr("connection.why.contactSwitched", { contact, transport, from });
      if (entry.cause === "dropped") return tr("connection.why.dropped", { transport, from });
      if (entry.relayed) return tr("connection.why.autoRelayed", { transport, from });
      return tr("connection.why.auto", { transport, from });
    case "failed": return join(entry.reason ?? tr("connection.why.failedDefault"), !!entry.transport && tr("connection.why.stayedOn", { transport }));
    case "lost":
      if (entry.fallback === "dht-only") return tr("connection.why.lostDhtOnly");
      if (entry.fallback === "dht") return tr("connection.why.lostDht", { from });
      if (entry.fallback === "hold") return tr("connection.why.lostHold", { from, contact });
      return tr("connection.why.lost", { from, contact });
    case "dht-only": return entry.cause === "contact" ? tr("connection.why.contactDhtOnly", { contact }) : tr("connection.why.youDhtOnly");
    case "dht-left": return entry.transport ? tr("connection.why.dhtLeftChosen", { transport }) : tr("connection.why.dhtLeftAuto");
    case "flapping": return tr("connection.why.flapping", { count: entry.count ?? 0, from: format(entry.since ?? entry.at), to: format(entry.at) });
  }
}

/** How the menu lists them: the one every app has first, then the native ones. */
const MENU_ORDER: PairedTransport[] = ["webrtc/1", "iroh/1", "hyperdht/1"];

/** A transport the chat's menu offers, or why it cannot. */
export interface TransportOption {
  transport: PairedTransport;
  available: boolean;
  reason?: string;
  /** A session on it would go through a relay: a fallback when nothing direct connects. */
  relayed?: boolean;
}

/** Why this app lacks a transport, and how to get it where there is a way. */
function missing(transport: PairedTransport, tr: Translate): string {
  if (transport === "webrtc/1") return tr("connection.option.noWebrtc");
  if (transport === "hyperdht/1") return tr("connection.option.hyperdhtNeeds");
  return tr("connection.option.needsDesktop", { transport: name(transport) });
}

type OwnTransports = Pick<LinkView, "availableTransports" | "runnableTransports" | "deliveryMode">;

/**
 * The transports this app has for the chat: those started, or on DHT only (which releases the native ones) every one
 * it can start, so leaving DHT only is offered on an app with no WebRTC too.
 */
export function ownTransports(link: OwnTransports): PairedTransport[] {
  return (link.deliveryMode === "dht" ? link.runnableTransports : undefined) ?? link.availableTransports ?? [];
}

/**
 * What the chat's Connection menu offers: transports this app runs and the contact's app supports on this link
 * (per its last word; unknown before a first session, then only this app's side is known). Never one this app lacks.
 */
export function transportOptions(link: OwnTransports & Pick<LinkView, "peerTransports" | "transportErrors" | "relayedTransports">, tr: Translate = englishT): TransportOption[] {
  const mine = ownTransports(link), theirs = link.peerTransports;
  return MENU_ORDER.map(transport => {
    const error = link.transportErrors?.[transport];
    if (!mine.includes(transport)) return { transport, available: false, reason: error ?? missing(transport, tr) };
    if (theirs && !theirs.includes(transport)) return { transport, available: false, reason: tr("connection.option.contactLacks", { transport: name(transport) }) };
    return { transport, available: true, ...(link.relayedTransports?.includes(transport) ? { relayed: true } : {}) };
  });
}

export type TimelineRow<M> =
  | { kind: "message"; message: M }
  | { kind: "transport"; entry: TransportEntry; earlier: TransportEntry[] }
  | { kind: "identity"; entry: IdentityTimelineEntry };

/**
 * Messages, the chat's transport rows and its identity shares in one timeline, by time. Transport rows with nothing
 * between them are one row: the latest, with the ones before it in `earlier` (its details list them), so the
 * timeline never shows a column of them. A legacy flapping row stays where it began. An identity share is its own
 * row, where it began (its later steps settle it in place).
 */
export function mergeTimeline<M extends { timestamp: number }>(messages: readonly M[], lines: readonly TransportEntry[], identities: readonly IdentityTimelineEntry[] = []): TimelineRow<M>[] {
  const at = (e: TransportEntry) => e.since ?? e.at;
  const sorted = [...lines].sort((a, b) => at(a) - at(b));
  const shares = [...identities].sort((a, b) => a.at - b.at);
  const out: TimelineRow<M>[] = [];
  let i = 0, j = 0;
  const rows = (until: number) => {
    let run: TransportEntry[] = [];
    const flush = () => { if (run.length) out.push({ kind: "transport", entry: run[run.length - 1], earlier: run.slice(0, -1) }); run = []; };
    while ((i < sorted.length && at(sorted[i]) <= until) || (j < shares.length && shares[j].at <= until)) {
      if (j < shares.length && shares[j].at <= until && (i >= sorted.length || at(sorted[i]) > until || shares[j].at < at(sorted[i]))) {
        flush();
        out.push({ kind: "identity", entry: shares[j++] });
      } else run.push(sorted[i++]);
    }
    flush();
  };
  for (const message of messages) {
    rows(message.timestamp);
    out.push({ kind: "message", message });
  }
  rows(Infinity);
  return out;
}

/** How long, to the second when short: the connection history is about exact moments. */
function duration(ms: number, tr: Translate): string {
  return ms < 60_000 ? tr("connection.duration.seconds", { n: Math.max(1, Math.round(ms / 1_000)) }) : lasting(ms, tr);
}

/** One event of the connection panel's history, in a line. */
export function transportEventText(event: TransportEvent, contact: string, tr: Translate = englishT): string {
  const transport = name(event.transport), rtt = event.rttMs !== undefined ? tr("connection.ms", { ms: event.rttMs }) : undefined;
  const parts = (...items: (string | false | undefined)[]) => items.filter(Boolean).join(" · ");
  switch (event.kind) {
    case "live": {
      const how = event.started ? tr("connection.event.started") : event.downMs !== undefined ? tr("connection.event.afterDown", { duration: duration(event.downMs, tr) }) : undefined;
      return parts(event.from ? tr("connection.event.liveFrom", { transport, from: name(event.from) }) : tr("connection.event.live", { transport }), how, rtt);
    }
    case "down": {
      // The live stretch this app quit in, not back by the time the contact's side would have let it go.
      if (event.restart) return tr("connection.event.notBack", { from: name(event.from) });
      const meanwhile = event.text === "dht" ? tr("connection.event.textsDht") : event.text === "hold" ? tr("connection.event.messagesWait", { contact }) : undefined;
      // Off live to wait for a chosen transport (Fallback off), not a drop.
      if (event.target) return parts(tr("connection.waitingFor", { transport: name(event.target) }), !!event.from && tr("connection.event.offFrom", { from: name(event.from) }), meanwhile);
      return parts(event.from ? tr("connection.event.lostFrom", { from: name(event.from) }) : tr("connection.line.lost"), meanwhile, event.reason);
    }
    case "switched": {
      const why = event.cause === "you" ? tr("connection.event.yourChoice") : event.cause === "contact" ? tr("connection.event.contactsChoice", { contact })
        : event.cause === "dropped" ? tr("connection.event.afterDrop") : tr("connection.event.automatic");
      return parts(tr("connection.event.moved", { from: name(event.from), transport }), why, rtt);
    }
    case "chose":
      if (event.target) return event.cause === "contact" ? tr("connection.line.contactChose", { contact, transport: name(event.target) }) : tr("connection.line.youChose", { transport: name(event.target) });
      return event.cause === "contact" ? tr("connection.line.contactBackAuto", { contact }) : tr("connection.event.youBackAuto");
    case "failed": return couldNotSwitch(event.target, event.reason, tr);
    case "attempt":
      if (event.target) return parts(tr("connection.waitingFor", { transport: name(event.target) }), !!event.reason && tr("connection.event.lastAttempt", { reason: shortReason(event.reason) }));
      return event.reason ? tr("connection.line.withReason", { text: tr("connection.event.attemptFailed"), reason: shortReason(event.reason) }) : tr("connection.event.attemptFailed");
    case "dht-only": return event.cause === "contact" ? tr("connection.line.contactDhtOnly", { contact }) : tr("connection.line.youDhtOnly");
    case "dht-left": return parts(tr("connection.event.dhtLeft"), event.transport ? tr("connection.event.setTo", { transport }) : tr("connection.event.automatic"));
  }
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * What a chat waits for, said for people (WISP 100, "A chosen transport not reached yet"): the header's label when
 * nothing else carries the chat, why in a sentence, where the chat is meanwhile, and whether Automatic is the way out
 * (the contact's app lacks it). `contact`: the name the chat shows for the other side.
 */
export function transportWaitText(wait: TransportWait, contact: string, format: (at: number) => string = clock, tr: Translate = englishT):
  { label: string; why: string; meanwhile: string; automatic: boolean } {
  const transport = name(wait.transport);
  const who = wait.by === "you" ? tr("connection.line.youChose", { transport }) : wait.by === "contact" ? tr("connection.line.contactChose", { contact, transport }) : tr("connection.wait.fallbackOff", { transport });
  const next = wait.retryAt ? tr("connection.wait.retryAt", { time: format(wait.retryAt) }) : tr("connection.wait.retryAuto");
  const reason = {
    "unknown": () => tr("connection.wait.unknown", { contact, transport }),
    "starting": () => tr("connection.wait.starting", { contact, transport }),
    "connecting": () => tr("connection.wait.connecting", { transport }),
    "unreachable": () => `${wait.error ? tr("connection.wait.failedWith", { reason: shortReason(wait.error) }) : tr("connection.wait.failed")} ${next}`,
    "waiting": () => tr("connection.wait.waiting", { contact }),
    "contact-lacks": () => tr("connection.wait.contactLacks", { contact, transport }),
    "app-lacks": () => wait.by === "contact" ? tr("connection.wait.appLacks", { transport }) : tr("connection.wait.appLacksNow", { transport }),
  }[wait.reason]();
  return {
    label: tr("connection.waitingFor", { transport }),
    why: tr("connection.wait.why", { who, reason }),
    meanwhile: wait.live ? tr("connection.wait.stays", { transport: name(wait.live) }) : tr("connection.wait.dht"),
    automatic: wait.reason === "contact-lacks" || (wait.reason === "app-lacks" && wait.by !== "contact"),
  };
}

/**
 * Why a chat on the DHT is not live, said for people (WISP 100, "Why a chat is not live"): what this side's last
 * attempt tried and why each did not connect, and when it tries again; on the side that answers, that the contact's
 * app dials, and what of its attempts reached this one. Nothing when there is nothing to say yet.
 */
export function liveAttemptText(attempt: LiveAttempt | undefined, dialer: "you" | "contact" | undefined, contact: string,
  format: (at: number) => string = clock, tr: Translate = englishT): { label: string; lines: string[] } | undefined {
  if (!attempt && dialer !== "contact") return undefined;
  const lines: string[] = [];
  if (dialer === "contact") lines.push(tr("connection.attempt.contactDials", { contact }));
  if (!attempt) return { label: tr("connection.attempt.notLiveYet"), lines: [...lines, tr("connection.attempt.none", { contact })] };
  if (attempt.side === "answered") lines.push(tr("connection.attempt.answered", { contact }));
  for (const f of attempt.failed) lines.push(tr("connection.attempt.failure", { transport: name(f.transport), reason: shortReason(f.error) }));
  if (!attempt.failed.length && attempt.reason) lines.push(tr("connection.attempt.reason", { reason: shortReason(attempt.reason) }));
  if (attempt.retryAt) lines.push(tr("connection.attempt.retryAt", { time: format(attempt.retryAt) }));
  return { label: tr("connection.attempt.label", { time: format(attempt.at) }), lines };
}

/** The live transport of a chat: on it, and nothing moving. */
export function liveTransport(link?: Pick<LinkView, "dataLink" | "pairing" | "deliveryMode">): PairedTransport | undefined {
  const pair = link?.pairing;
  return link?.dataLink === "open" && pair?.status === "ready" && link.deliveryMode !== "dht" ? pair.transport : undefined;
}

/** How long something has lasted, as a person says it: "less than a minute", "12 min", "3 h", "2 days". */
export function lasting(ms: number, tr: Translate = englishT): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return tr("connection.duration.lessThanMinute");
  if (minutes < 60) return tr("connection.duration.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return tr("connection.duration.hours", { n: hours });
  return tr("connection.duration.days", { n: Math.floor(hours / 24) });
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

export function connectionSummary(link: LinkView | undefined, now: number, contact?: string, tr: Translate = englishT): ConnectionSummary | undefined {
  const transport = liveTransport(link);
  if (!link || !transport) return undefined;
  const t = name(transport), chosen = link.transportAutomatic === false || (link.transportAutomatic === undefined && link.preferredTransport !== undefined);
  const cause = link.transportLive?.cause, only = (link.availableTransports ?? []).length === 1;
  const relayed = link.transportRelayed;
  const [whyShort, why] = only ? [tr("connection.summary.onlyShort"), tr("connection.summary.only", { transport: t })]
    : cause === "contact" ? [contact ? tr("connection.event.contactsChoice", { contact }) : tr("connection.summary.yourContactsChoice"), tr("connection.summary.contactChose", { contact: contact ?? tr("pairing.contact"), transport: t })]
    : chosen && link.preferredTransport === transport ? [tr("connection.event.yourChoice"), tr("connection.summary.youChose", { transport: t })]
    : chosen ? [tr("connection.summary.fallbackShort"), tr("connection.summary.fallback", { preferred: name(link.preferredTransport), transport: t })]
    : cause === "dropped" ? [tr("connection.summary.afterDropShort"), tr("connection.summary.afterDrop", { transport: t })]
    : relayed ? [tr("connection.summary.noDirectShort"), tr("connection.summary.noDirect", { transport: t })]
    : [tr("connection.event.automatic"), transport === "webrtc/1" ? tr("connection.summary.automaticWebrtc") : tr("connection.summary.automatic", { transport: t })];
  const since = link.transportLive?.since;
  const rtt = link.transportRttMs !== undefined ? [tr("connection.ms", { ms: link.transportRttMs })] : [];
  const path = relayed ? [tr("connection.relayed")] : [];
  const parts = [...path, ...rtt, ...(since !== undefined ? [tr("connection.summary.liveFor", { duration: lasting(now - since, tr) })] : []), whyShort];
  return { transport, name: t, rttMs: link.transportRttMs, since, relays: relayed?.relays, whyShort,
    why: relayed ? tr("connection.summary.relayedWhy", { why, relays: relayed.relays.join(tr("connection.summary.relaysJoin")) || tr("connection.summary.aRelay") }) : why,
    line: [t, ...parts].join(" · "), detail: parts.join(" · "), short: [t, ...path, ...rtt, whyShort].join(" · ") };
}
