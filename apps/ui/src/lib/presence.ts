import { useSyncExternalStore } from "react";
import { liveStatus, type PersonStatus, type Presence, type StatusAvailability } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { LinkView } from "@ghostly/browser/shared/types";
import { sameValue } from "./sameValue";
import type { Translate } from "../locales/translate";

/*
 * A contact's presence and the status they set (WISP 401 § Presence and status), as the engine's state says them on
 * each paired 1:1 chat's link (`peerPresence`, `peerStatus`). The chat list draws a row per contact and is handed a
 * new state several times a second, so the contacts' presence is read once per state into one map by key: a row, the
 * header and the contact panel each look theirs up in it. An entry that did not change keeps its object, so only the
 * row whose contact changed is drawn again. A status past its end is no status; the map is read again at the next
 * end by one timer for all of them, not a clock per row.
 */

/** What a contact says of themselves now: online (active or idle) when they share it, and a status while it lasts. */
export interface PeerPresence { presence?: Presence; status?: PersonStatus }

/** How the dot on a contact's picture looks: by their status's availability first, then by whether they are idle. */
export type PresenceTone = "online" | "idle" | "away" | "busy" | "dnd";

/** The longest a timer waits: a later end is waited for in steps. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/** What a link says, a status already over left out; undefined when it says nothing. */
export function peerPresenceOf(link: Pick<LinkView, "peerPresence" | "peerStatus">, now = Date.now()): PeerPresence | undefined {
  const status = liveStatus(link.peerStatus, now);
  if (!link.peerPresence && !status) return undefined;
  return { ...(link.peerPresence ? { presence: link.peerPresence } : {}), ...(status ? { status } : {}) };
}

let built: { state: typeof engine.state; clock: number; map: ReadonlyMap<string, PeerPresence> } | undefined;
/** Bumped at a status's end: the map is built again without it, though the engine's state is the same. */
let clock = 0;
let endTimer: ReturnType<typeof setTimeout> | undefined;
const clockListeners = new Set<() => void>();

/** Waits for the earliest end still to come among `ends` (one timer, whatever the number of contacts). */
function armEnd(ends: number[], now: number) {
  clearTimeout(endTimer);
  endTimer = undefined;
  const next = Math.min(...ends.filter(until => until > now));
  if (!Number.isFinite(next)) return;
  endTimer = setTimeout(() => {
    endTimer = undefined;
    clock++;
    for (const listener of [...clockListeners]) listener();
  }, Math.min(next - now + 1, TIMER_MAX_MS));
}

/**
 * Every paired contact's presence and status in this state, by their key: built once per state (and once more at a
 * status's end), whatever the number of rows reading it. An entry the same as before keeps its object.
 */
export function presenceIndex(state: typeof engine.state = engine.state): ReadonlyMap<string, PeerPresence> {
  if (built && built.state === state && built.clock === clock) return built.map;
  const previous = built?.map;
  const now = Date.now();
  const map = new Map<string, PeerPresence>();
  const ends: number[] = [];
  for (const link of state?.links ?? []) {
    if (!link.peerPubKeyZ32 || (!link.peerPresence && !link.peerStatus)) continue;
    if (link.peerStatus?.until !== undefined) ends.push(link.peerStatus.until);
    const entry = peerPresenceOf(link, now);
    if (!entry) continue;
    const before = previous?.get(link.peerPubKeyZ32);
    map.set(link.peerPubKeyZ32, before && sameValue(before, entry) ? before : entry);
  }
  armEnd(ends, now);
  built = { state, clock, map };
  return map;
}

const subscribe = (listener: () => void) => {
  const stop = engine.subscribe(listener);
  clockListeners.add(listener);
  return () => { stop(); clockListeners.delete(listener); };
};

/** One contact's presence and status, drawn again only when theirs changes or their status ends. */
export function usePeerPresence(peerKey: string | undefined): PeerPresence | undefined {
  return useSyncExternalStore(subscribe, () => (peerKey ? presenceIndex().get(peerKey) : undefined));
}

/** The dot's look, or none while the contact does not say they are online (WISP 401: no `p`, no dot). */
export function presenceTone(entry: PeerPresence | undefined): PresenceTone | undefined {
  if (!entry?.presence) return undefined;
  const availability = entry.status?.availability;
  if (availability === "dnd" || availability === "busy" || availability === "away") return availability;
  return entry.presence === "idle" ? "idle" : "online";
}

/** An availability worth saying in words: "available" goes without saying. */
export function shownAvailability(entry: PeerPresence | undefined): Exclude<StatusAvailability, "available"> | undefined {
  const availability = entry?.status?.availability;
  return availability && availability !== "available" ? availability : undefined;
}

/** The dot's words: "Online", "Online, idle", "Online, do not disturb". */
export function presenceLabel(t: Translate, tone: PresenceTone): string {
  return t(`chat.presence.dot.${tone}`);
}

/** The status in words, emoji first: "🌴 On holiday", or the availability ("Busy") when it has no text. */
export function statusText(t: Translate, entry: PeerPresence | undefined): string | undefined {
  const availability = shownAvailability(entry);
  const text = entry?.status?.text ?? (availability && t(`chat.presence.availability.${availability}`));
  const words = [entry?.status?.emoji, text].filter(Boolean).join(" ");
  return words || undefined;
}

/**
 * What a screen reader hears of a contact's presence and status, for a name that hides the marks (the chat list's
 * row): "Online, busy" and "Status: 🌴 On holiday". Nothing when they say nothing.
 */
export function presenceWords(t: Translate, entry: PeerPresence | undefined): string[] {
  const tone = presenceTone(entry), status = statusText(t, entry);
  return [tone && presenceLabel(t, tone), status && t("chat.presence.status", { status })].filter((part): part is string => !!part);
}

/** For tests: forget the map and the timer, as a new page would. */
export function resetPresenceIndex() {
  built = undefined;
  clearTimeout(endTimer);
  endTimer = undefined;
}
