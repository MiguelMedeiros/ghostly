import { useEffect, useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { identityProvider, identityProviders } from "@ghostly/browser/proofs/registry";
import { availableSigners } from "@ghostly/browser/proofs/verify";
import type { IdentityPlatform, IdentityProofProvider } from "@ghostly/browser/proofs/contract";
import type { IdentityStatus, SharedIdentity } from "@ghostly/core";
import type { ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { getPrefix, listSessions } from "./storage";
import type { ChatSession } from "./types";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
/** The engine's state, re-rendered on every change. */
export const useEngineState = () => useSyncExternalStore(subscribe, snapshot);

/**
 * Calls `onNew` with a proof that was not there on the last render: one just added comes up in a deck of ID cards, so
 * the person sees what they made. Nothing on the first state (what the profile already had).
 */
export function useNewProof(state: typeof engine.state | undefined, onNew: (id: string) => void) {
  const ids = state ? (state.identityProofs ?? []).map(p => p.id).join(" ") : null;
  const known = useRef<string[] | null>(null);
  const callback = useRef(onNew); callback.current = onNew;
  useEffect(() => {
    if (ids === null) return;
    const now = ids ? ids.split(" ") : [];
    const fresh = known.current && now.find(id => !known.current!.includes(id));
    if (fresh) callback.current(fresh);
    known.current = now;
  }, [ids]);
}

/** Where this page runs, for signers that only work on some platforms (a NIP-07 extension is in web pages). */
export function identityPlatform(): IdentityPlatform {
  if (typeof location !== "undefined" && /-extension:$/.test(location.protocol)) return "extension";
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "desktop";
  return "web";
}

/** Providers that can be added here: on this platform, with at least one signer available now. */
export function addableProviders(): IdentityProofProvider[] {
  const platform = identityPlatform();
  return identityProviders().filter(p => p.platforms.includes(platform) && availableSigners(p, platform).length > 0);
}

export const providerOf = (id: string) => identityProvider(id);
export const providerLabel = (id: string) => identityProvider(id)?.label ?? id;
export const shortSubject = (provider: string, subject: string) => {
  const p = identityProvider(provider);
  try { return p?.subject.short?.(subject) ?? subject; } catch { return subject; }
};
export const categoryLabel = (id: string, attester?: string) =>
  identityProvider(id)?.category === "provider-attested" ? `Attested by ${attester ?? "the provider"}` : "Their own key";

export const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const dateTime = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const RECEIVED_STATUS: Record<IdentityStatus, string> = {
  verified: "Verified",
  expired: "Expired",
  withdrawn: "No longer shared",
  revoked: "Revoked by its owner",
  unconfirmed: "Could not be confirmed",
  "previous-key": "From a previous key",
};
export const SHARED_STATUS: Record<SharedIdentity["status"], string> = {
  queued: "Shared when you next connect",
  pending: "Waiting for your contact",
  accepted: "Shared · verified by your contact",
  rejected: "Not verified by your contact",
  "withdrawal-pending": "Stopping…",
  withdrawn: "Not shared",
};

/** The engine's status, with expiry applied at render time: an expired proof is never shown as verified. */
export const currentStatus = (r: ReceivedIdentityView, now = Date.now() / 1000): IdentityStatus =>
  r.status === "verified" || r.status === "unconfirmed" ? (r.expiresAt <= now ? "expired" : r.status) : r.status;

/**
 * When a proof counts as expiring soon: in its last week, or its last quarter when it was made for less
 * than a month (a 7-day proof is not "expiring" the day it is made).
 */
export const expiringSoon = (p: { issuedAt: number; expiresAt: number }, now = Date.now() / 1000) =>
  p.expiresAt > now && p.expiresAt - now < Math.min(7 * 86400, (p.expiresAt - p.issuedAt) / 4);

/** Whole days left, at least 1 while it is still valid. */
export const daysLeft = (expiresAt: number, now = Date.now() / 1000) => Math.max(1, Math.ceil((expiresAt - now) / 86400));

/**
 * Something about identities the person should look at. `lasting` ones stay until they are dealt with
 * (a proof of this profile expiring or expired: renew or remove it); the others are news (a contact's
 * proof revoked or no longer confirmed, a contact who could not verify one of yours) and stop counting
 * once seen on the Identities page.
 */
export interface IdentityAttention { key: string; lasting: boolean }

export function identityAttention(state: typeof engine.state, now = Date.now() / 1000): IdentityAttention[] {
  if (!state) return [];
  const items: IdentityAttention[] = [];
  for (const p of state.identityProofs ?? []) {
    if (p.expiresAt <= now) items.push({ key: `expired/${p.id}`, lasting: true });
    else if (expiringSoon(p, now)) items.push({ key: `expiring/${p.id}`, lasting: true });
  }
  for (const link of state.links ?? []) {
    for (const s of link.identities?.shared ?? []) if (s.status === "rejected") items.push({ key: `rejected/${link.id}/${s.id}/${s.at}`, lasting: false });
    for (const r of link.identities?.received ?? []) {
      const status = currentStatus(r, now);
      // Not keyed by the check's time: a proof still unconfirmed at the next automatic check is not news again.
      if (status === "revoked" || status === "unconfirmed") items.push({ key: `${status}/${link.id}/${r.id}`, lasting: false });
    }
  }
  return items;
}

const seenKey = () => `${getPrefix()}identities_seen`;
const rawSeen = () => { try { return localStorage.getItem(seenKey()) ?? ""; } catch { return ""; } };
const parseSeen = (raw: string): string[] => { try { const v: unknown = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []; } catch { return []; } };

/** Marks the news shown now as seen (only the current items are kept, so the list never grows). */
export function markIdentityNewsSeen(items: IdentityAttention[]): void {
  const keys = items.filter(i => !i.lasting).map(i => i.key);
  const before = parseSeen(rawSeen());
  if (keys.length === before.length && keys.every(k => before.includes(k))) return;
  try { localStorage.setItem(seenKey(), JSON.stringify(keys)); } catch { /* storage blocked: the dot just stays */ }
  window.dispatchEvent(new Event("identities-seen"));
}

/** What still needs attention: lasting items, and news not seen yet. */
export function unseenAttention(items: IdentityAttention[], seen: string[] = parseSeen(rawSeen())): IdentityAttention[] {
  return items.filter(i => i.lasting || !seen.includes(i.key));
}

const subscribeSeen = (listener: () => void) => {
  window.addEventListener("identities-seen", listener); window.addEventListener("storage", listener);
  return () => { window.removeEventListener("identities-seen", listener); window.removeEventListener("storage", listener); };
};

/** Whether the Identities item carries its dot. */
export function useIdentityAttention(): boolean {
  const state = useEngineState();
  const seen = useSyncExternalStore(subscribeSeen, rawSeen);
  return unseenAttention(identityAttention(state), parseSeen(seen)).length > 0;
}

/** The chats by contact key, for a contact's name and a way back into the chat. Read once per render. */
export const chatsByPeer = (): Map<string, ChatSession> => new Map(listSessions().map(s => [s.peerPubKeyB64, s]));
/** A contact's name as the chat list shows it; undefined when they have none. */
export const contactName = (chat: ChatSession | undefined): string | undefined => chat?.label || chat?.nick || undefined;
