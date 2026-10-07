import type { Translate } from "../contexts/I18nContext";
import { knownErrorParts, rawError, readable } from "./errorText";
import { english } from "./english";

/*
 * An error as the app shows it (components/ui/Notice.tsx): a title of a few words saying what happened, maybe a next
 * step, and the engine's own English (relay addresses, error names, codes) as the detail behind an ⓘ, never in the line.
 * `errorText` says the errors it knows in the app's language. One it does not know is shown as it came only when it is a
 * short line a person can read; anything longer or technical gets a generic title, and its English goes to the detail.
 */

/** `error`: the person has something to do; `wait`: the app tries again by itself (never red). */
export type ProblemTone = "error" | "wait" | "warning";

export interface Problem {
  title: string;
  next?: string;
  /** The error as it was thrown, for the ⓘ: only when the title does not already say all of it. */
  detail?: string;
  tone: ProblemTone;
}

/** What a relay error comes down to: every relay holding back or cooling down (a wait), or a relay failing now. */
export interface RelayCause { kind: "wait" | "unreachable"; retryInS?: number }

/** The words around a relay error that say where it happened, not why: taken off before the reasons are read. */
const WRAPPERS = [
  /Could not (?:publish|read) discovery:\s*/g, /Could not publish connection details:\s*/g, /Could not read DHT delivery:\s*/g,
  /Publish (?:failed|held back) on every relay(?: not left alone)?:\s*/g, /(?:[A-Z][A-Za-z]*)?Error:\s*/g, /Retrying(?: in \d+ s)?\.?/g,
];
/** A relay error at all: the link's discovery, its connection details, the relays' budget and breaker (packages/core). */
const RELAY = /Could not (?:publish|read) discovery:|Could not publish connection details:|Publish (?:failed|held back) on every relay|No Pkarr relay reachable|Discovery request budget|DiscoveryBudgetError|is left alone after failing|Discovery relay is (?:cooling down|throttling)/;
/** A reason that is a wait: this client's budget, a relay's rate limit, a relay the breaker leaves alone for a while. */
const SOFT = /budget reached|held back|is left alone after failing|cooling down|throttling|retry shortly|^\s*(?:asked again in \d+ s)?\s*$/i;

/** A relay error read: null when it is none. A mix of waits and a relay failing now is a failure (relay.ts). */
export function relayCause(text: string): RelayCause | null {
  if (!RELAY.test(text)) return null;
  const waits = [...text.matchAll(/(?:asked again|Retrying) in (\d+) s/g)].map((m) => Number(m[1]));
  const retryInS = waits.length ? Math.min(...waits) : undefined;
  let reasons = text;
  for (const wrapper of WRAPPERS) reasons = reasons.replace(wrapper, "");
  const parts = reasons.split(/;\s*|\.\s+/).map((part) => part.replace(/; asked again in \d+ s/, "").trim()).filter(Boolean);
  const wait = parts.length > 0 && parts.every((part) => SOFT.test(part));
  return { kind: wait ? "wait" : "unreachable", ...(retryInS !== undefined && { retryInS }) };
}

/** A live session that ended in a way that says nothing about the contact: it is dialled again (packages/core). */
const SESSION_DROPS = [/^Session receive queue full$/, /^The peer did not finish authentication\b/, /^Invalid session negotiation$/];

/**
 * A Reconnect that ran out of time (packages/core ghostlink.ts `connect`): the contact is not there yet, and the link
 * keeps dialling by itself. A wait, in the app's language: it showed in red, in English, in every language (2026-10-07).
 */
const DIAL_TIMEOUTS = [/^Timed out connecting to the peer$/];

/** A session the peer broke the protocol on (packages/core pairedSession.ts): it says nothing a person can act on. */
const PROTOCOL = [/^Session frame too large$/, /^Negotiation message too large$/, /^Invalid connection binding\b/];

/** What `fallback` titles an error nothing here knows: a connection's own words, or the app's generic ones. */
export type ProblemFallback = "connect" | "generic";

/** `cause` as a notice says it (see above). */
export function problemText(cause: unknown, t: Translate = english, fallback: ProblemFallback = "generic"): Problem {
  const raw = rawError(cause);
  const relays = relayCause(raw);
  if (relays) {
    const retry = relays.retryInS !== undefined ? t("errors.problem.retryIn", { s: relays.retryInS }) : t("errors.problem.retrying");
    return relays.kind === "wait"
      ? { tone: "wait", title: t("errors.problem.relaysWait"), next: retry, detail: raw }
      : { tone: "error", title: t("errors.problem.relaysUnreachable"), next: t("errors.problem.checkConnection"), detail: raw };
  }
  if (SESSION_DROPS.some((drop) => drop.test(raw))) return { tone: "wait", title: t("errors.problem.sessionDropped"), next: t("errors.problem.retrying"), detail: raw };
  if (DIAL_TIMEOUTS.some((timeout) => timeout.test(raw))) return { tone: "wait", title: t("errors.problem.connectFailed"), next: t("errors.problem.retrying"), detail: raw };
  // A known error is said in the app's language: its English in an ⓘ only when part of it (a reason) is not said.
  // Known also without the final period a message around it took ("…: <reason>. Nothing was saved").
  const parts = knownErrorParts(raw, t) ?? (raw && !raw.endsWith(".") ? knownErrorParts(`${raw}.`, t) : null);
  if (parts) return { tone: "error", ...parts };
  if (raw && readable(raw) && !PROTOCOL.some((p) => p.test(raw))) return { tone: "error", title: raw };
  // "Not a relay address: ftp://x": the words before the first colon say it, the rest goes behind the ⓘ.
  const head = raw.split(/:\s/)[0]!;
  if (head !== raw && head.length >= 8 && readable(head) && !PROTOCOL.some((p) => p.test(head))) return { tone: "error", title: head, detail: raw };
  return { tone: "error", title: t(fallback === "connect" ? "errors.problem.connectFailed" : "errors.generic"), ...(raw && { detail: raw }) };
}

/** A problem as one line, where only a line fits (a status under a name, a hint): its title and next line together. */
export function problemLine(cause: unknown, t: Translate = english, fallback: ProblemFallback = "generic"): string {
  const { title, next } = problemText(cause, t, fallback);
  if (!next) return title;
  if (/[.!?…。！？]$/.test(title)) return `${title} ${next}`;
  return t.language === "ja" || t.language === "zh" ? `${title}。${next}` : `${title}. ${next}`;
}
