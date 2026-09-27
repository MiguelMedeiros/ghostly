import type { PeekChat, PeekResult } from "@ghostly/browser/engine/profilePeek";
import type { ChatSession } from "./types";
import type { AppSettings } from "./settings";
import { activeProfileId, listProfiles, prefixOf, registryKey } from "./profiles";
import { profileDatabase, profileLock, runningElsewhere } from "./profileData";

/*
 * Checking other profiles for new messages (WISP 04 § Checking other profiles). The running app asks its peer, now
 * and then, to look at what waits for each other unlocked profile of this device (`peekProfile`: reads only). What
 * was seen is kept here, on the device, until that profile runs again: a DHT text stays in its mailbox only minutes,
 * and "new" must not vanish with it. The other profile's own storage is never written from here.
 */

/** One chat of another profile with something waiting: DHT texts seen (their ids), and items held for it. */
interface PeekedChat { peer: string; base: number; texts: string[]; held: number }
interface PeekStore { [profile: string]: { at: number; chats: Record<string, PeekedChat> } }

export const PEEK_EVENT = "profile-peek-updated";
/** What a system notice about another profile opens: `profile:<id>`, a switch to it. */
export const PROFILE_NOTICE = "profile:";
/** Beside the registry, one per storage space; never under a profile's prefix, so no profile's scans take it for a chat. */
const storeKey = () => `${registryKey().replace(/_/g, "-")}-peek`;

function readStore(): PeekStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(storeKey()) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PeekStore : {};
  } catch { return {}; }
}
function writeStore(store: PeekStore): void {
  try { localStorage.setItem(storeKey(), JSON.stringify(store)); } catch { /* storage unavailable: nothing is remembered */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PEEK_EVENT));
}

const waiting = (chat: PeekedChat) => chat.texts.length > 0 || chat.held > 0;

/** How many chats of that profile have something new waiting, as last seen from another profile. */
export function peekFresh(profile: string): number {
  return Object.values(readStore()[profile]?.chats ?? {}).filter(waiting).length;
}

/** The profile runs now: its own engine fetches what waits, so what was seen from elsewhere is forgotten. */
export function clearPeek(profile: string): void {
  const store = readStore();
  if (!(profile in store)) return;
  delete store[profile];
  writeStore(store);
}

/**
 * Takes one round's result for a profile. A chat's texts are kept while that profile's own reading of the contact
 * (`peerSequence`) has not moved: once it moved, the profile ran and took them. Returns the chats that had nothing
 * waiting before and have something now.
 */
export function mergePeek(profile: string, result: Pick<PeekResult, "chats">, now = Date.now()): PeekChat[] {
  const store = readStore(), was = JSON.stringify(store);
  const known = new Set(listProfiles().map((p) => p.id));
  for (const id of Object.keys(store)) if (!known.has(id)) delete store[id];
  const entry = store[profile] ?? { at: 0, chats: {} };
  const seenBefore = JSON.stringify(entry.chats);
  const fresh: PeekChat[] = [];
  for (const chat of result.chats) {
    const before = entry.chats[chat.linkId];
    const kept = before && before.base === chat.peerSequence ? before.texts : [];
    const texts = [...new Set([...kept, ...(chat.text ? [chat.text] : [])])].slice(-20);
    const next: PeekedChat = { peer: chat.peer, base: chat.peerSequence, texts, held: chat.held };
    if (waiting(next)) {
      if (!before || !waiting(before)) fresh.push(chat);
      entry.chats[chat.linkId] = next;
    } else delete entry.chats[chat.linkId];
  }
  // Written (and the switcher told) only when something changed: most looks find nothing new.
  if (JSON.stringify(entry.chats) !== seenBefore) entry.at = now;
  store[profile] = entry;
  if (JSON.stringify(store) !== was) writeStore(store);
  return fresh;
}

/** On unless turned off, on Desktop (its reads go to the DHT); off unless turned on on the web and in the extension. */
export const peekEnabled = (settings: Pick<AppSettings, "profilePeek">, desktop: boolean) => settings.profilePeek?.enabled ?? desktop;
export const peekNotifies = (settings: Pick<AppSettings, "profilePeek">) => settings.profilePeek?.notify === true;

/** Another profile's chat is muted there (read only: an ended mute is left for that profile to forget). */
export function mutedInProfile(profile: string, peer: string, now = Date.now()): boolean {
  const prefix = prefixOf(profile);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) || key.slice(prefix.length).includes("_")) continue;
      const session = JSON.parse(localStorage.getItem(key) ?? "null") as ChatSession | null;
      if (session?.peerPubKeyB64 !== peer) continue;
      const raw = localStorage.getItem(`${prefix}mute_${session.id}`);
      return raw === "forever" || (!!raw && Number(raw) > now);
    }
  } catch { /* unreadable: not muted */ }
  return false;
}

/** The pace: about three minutes with jitter, so a DHT text (five minutes in its mailbox) is seen; slower when away. */
export const PEEK_PACE = { firstMs: 20_000, baseMs: 3 * 60_000, jitter: 0.15, hiddenFactor: 4, batteryFactor: 2 };

export function nextPeekDelay(options: { hidden: boolean; onBattery: boolean; random?: () => number; testMs?: number }): number {
  if (options.testMs) return options.testMs;
  const random = options.random ?? Math.random;
  const jittered = PEEK_PACE.baseMs * (1 + PEEK_PACE.jitter * (random() * 2 - 1));
  return Math.round(jittered * (options.hidden ? PEEK_PACE.hiddenFactor : 1) * (options.onBattery ? PEEK_PACE.batteryFactor : 1));
}

export interface PeekTarget { id: string; name: string; dbName: string }

/** The other profiles to look at now: not the running one, not locked, not running in another window. */
export async function peekTargets(): Promise<PeekTarget[]> {
  const active = activeProfileId();
  const out: PeekTarget[] = [];
  for (const entry of listProfiles()) {
    if (entry.id === active || profileLock(entry.id)) continue;
    if (await runningElsewhere(entry.id).catch(() => true)) continue;
    out.push({ id: entry.id, name: entry.name, dbName: profileDatabase(entry.id) });
  }
  return out;
}

export interface PeekLoopDeps {
  call(target: PeekTarget): Promise<PeekResult>;
  targets(): Promise<PeekTarget[]>;
  enabled(): boolean;
  hidden(): boolean;
  onBattery(): Promise<boolean>;
  onFresh(target: PeekTarget, chats: PeekChat[]): void;
  testMs?: number;
  random?: () => number;
}

/**
 * Runs the looks until stopped: one profile after the other, then the next round after `nextPeekDelay`. Turned off,
 * nothing is read at all; the loop only waits to see it on again. A failure waits for the next round.
 */
export function startPeekLoop(deps: PeekLoopDeps): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const round = async () => {
    if (stopped) return;
    if (deps.enabled()) {
      for (const target of await deps.targets().catch(() => [])) {
        if (stopped || !deps.enabled()) break;
        try {
          const result = await deps.call(target);
          if (stopped) break;
          const fresh = mergePeek(target.id, result);
          if (fresh.length) deps.onFresh(target, fresh);
          if (result.status === "budget") break;
        } catch { /* the next round */ }
      }
    }
    if (stopped) return;
    const onBattery = await deps.onBattery().catch(() => false);
    timer = setTimeout(() => void round(), nextPeekDelay({ hidden: deps.hidden(), onBattery, random: deps.random, testMs: deps.testMs }));
  };
  timer = setTimeout(() => void round(), deps.testMs ?? PEEK_PACE.firstMs);
  return () => { stopped = true; clearTimeout(timer); };
}

/** Where the Battery Status API exists (Chromium): running on battery. Elsewhere unknown, taken as not. */
export async function onBattery(): Promise<boolean> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean }> };
  if (!nav.getBattery) return false;
  return !(await nav.getBattery()).charging;
}
