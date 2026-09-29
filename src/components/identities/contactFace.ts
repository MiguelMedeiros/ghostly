import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";
import { hasPublicProfile } from "@ghostly/browser/profiles/readers";
import { badgeState, isGood } from "./contactBadges";
import { providerLabel, useEngineState } from "../../lib/identities";
import { getPrefix } from "../../lib/storage";

/*
 * "Show as this contact" (docs/wisps/PUBLIC-PROFILES.md, Name and photo): a contact may be shown in the chat list, the
 * chat's header and group mentions with the name and photo of one of their verified identities' public profiles
 * instead of their Ghostly name. The choice is this profile's, on this device, kept per contact key and never sent.
 *
 * The name: a nickname the user gave the contact (the chat's label) always wins; then the chosen identity's name;
 * then the name the contact goes by; then "Contact · xxxxxx". The photo: the chosen identity's, even under a nickname;
 * else the picture the contact sent.
 *
 * The choice holds only while its proof does. When the proof expires, is revoked or withdrawn, was made with a
 * previous key, or its profile is gone (or Load public profiles is off), the contact falls back at once: nothing is
 * shown from a proof this app no longer vouches for. The choice itself stays, so a renewed proof of the same identity
 * shows it again.
 */

/** An identity (provider and subject), or "none": the Ghostly name on purpose, which also ends the suggestion. */
export type FaceChoice = { provider: string; subject: string } | "none";

/** Sent on this page when a choice changes (another page of the app sees `storage`). */
export const FACE_EVENT = "contact-face-updated";

const faceKey = (peerKey: string) => `${getPrefix()}face_${peerKey}`;

function parseChoice(raw: string | null): FaceChoice | undefined {
  if (!raw) return undefined;
  if (raw === "none") return "none";
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && typeof (value as FaceChoice & object).provider === "string" && typeof (value as FaceChoice & object).subject === "string")
      return { provider: (value as { provider: string }).provider, subject: (value as { subject: string }).subject };
  } catch { /* unreadable: no choice */ }
  return undefined;
}

const rawChoice = (peerKey: string | undefined) => {
  if (!peerKey) return null;
  try { return localStorage.getItem(faceKey(peerKey)); } catch { return null; }
};

/** What was chosen for this contact, if anything. */
export const faceChoice = (peerKey: string | undefined): FaceChoice | undefined => parseChoice(rawChoice(peerKey));

/** Chooses how a contact is shown; undefined forgets the choice (and so brings back the suggestion). */
export function setFaceChoice(peerKey: string, choice: FaceChoice | undefined): void {
  try {
    if (choice === undefined) localStorage.removeItem(faceKey(peerKey));
    else localStorage.setItem(faceKey(peerKey), choice === "none" ? "none" : JSON.stringify({ provider: choice.provider, subject: choice.subject }));
  } catch { /* storage unavailable: nothing is remembered */ }
  window.dispatchEvent(new Event(FACE_EVENT));
}

/** Forgets a contact's choice with their chat. */
export function forgetFaceChoice(peerKey: string): void {
  try { localStorage.removeItem(faceKey(peerKey)); } catch { /* storage unavailable */ }
}

const subscribeChoices = (listener: () => void) => {
  window.addEventListener(FACE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(FACE_EVENT, listener); window.removeEventListener("storage", listener); };
};

/** The stored choice for one contact, redrawn when it changes. */
export function useFaceChoice(peerKey: string | undefined): FaceChoice | undefined {
  return parseChoice(useSyncExternalStore(subscribeChoices, () => rawChoice(peerKey)));
}

/**
 * A profile's name as plain text on one line: no control, format or bidi characters (they could make it read as
 * another contact or reorder what follows it), at most 64 characters. The engine already cleans it; this is the
 * last word before it names a contact.
 */
export function cleanFaceName(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, 64).join("").trim() || undefined;
}

/** How a contact can be shown: one of their verified identities with a public profile that has a name or a photo. */
export interface ContactFace {
  /** The received identity's id. */
  id: string;
  provider: string;
  subject: string;
  /** "Pubky", "Nostr": whose profile it is. */
  providerName: string;
  name?: string;
  /** A sanitized data URL, never a remote address. */
  photo?: string;
}

const faceOf = (r: ReceivedIdentityView, now: number): ContactFace | undefined => {
  const state = badgeState(r, now);
  if (!state || !isGood(state) || !hasPublicProfile(r.provider)) return undefined;
  const profile = r.publicProfile?.found ? r.publicProfile : undefined;
  const name = cleanFaceName(profile?.name);
  const photo = profile?.avatar?.startsWith("data:image/") ? profile.avatar : undefined;
  if (!name && !photo) return undefined;
  return { id: r.id, provider: r.provider, subject: r.subject, providerName: providerLabel(r.provider), ...(name ? { name } : {}), ...(photo ? { photo } : {}) };
};

/** Every identity a contact can be shown as, right now. */
export function faceCandidates(received: ReceivedIdentityView[] | undefined, now = Date.now() / 1000): ContactFace[] {
  return (received ?? []).flatMap(r => faceOf(r, now) ?? []);
}

/** The chosen identity, while its proof and profile still stand; else nothing (the contact falls back). */
export function contactFace(received: ReceivedIdentityView[] | undefined, choice: FaceChoice | undefined, now = Date.now() / 1000): ContactFace | undefined {
  if (!choice || choice === "none") return undefined;
  const r = (received ?? []).find(x => x.provider === choice.provider && x.subject === choice.subject);
  return r ? faceOf(r, now) : undefined;
}

/**
 * The identity to offer with one tap: the contact's only one with a profile, while nothing was chosen (not even
 * "Ghostly") and the user gave them no nickname. Offered, never applied by itself.
 */
export function suggestedFace(received: ReceivedIdentityView[] | undefined, choice: FaceChoice | undefined, nickname: string | undefined, now = Date.now() / 1000): ContactFace | undefined {
  if (choice !== undefined || nickname?.trim()) return undefined;
  const candidates = faceCandidates(received, now);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Where the name a contact is shown with comes from. */
export type ShownFrom = "nickname" | "identity" | "contact" | "key";

/** The name a contact is shown with, by the precedence above. `fallback` is "Contact · xxxxxx". */
export function shownContactName({ nickname, face, nick, fallback }: { nickname?: string; face?: ContactFace; nick?: string; fallback: string }): { name: string; from: ShownFrom } {
  if (nickname) return { name: nickname, from: "nickname" };
  if (face?.name) return { name: face.name, from: "identity" };
  if (nick) return { name: nick, from: "contact" };
  return { name: fallback, from: "key" };
}

const receivedOf = (links: LinkView[] | undefined, peerKey: string | undefined) =>
  peerKey ? links?.find(l => l.peerPubKeyZ32 === peerKey)?.identities?.received : undefined;

/** The contact's face as chosen, redrawn when the engine or the choice changes. */
export function useContactFace(peerKey: string | undefined): ContactFace | undefined {
  const state = useEngineState();
  return contactFace(receivedOf(state?.links, peerKey), useFaceChoice(peerKey));
}

const version = { n: 0 };
const subscribeVersion = (listener: () => void) => subscribeChoices(() => { version.n++; listener(); });

/** For a list of contacts: a function from a contact key to its face, redrawn when the engine or any choice changes. */
export function useContactFaces(): (peerKey: string | undefined) => ContactFace | undefined {
  const state = useEngineState();
  const v = useSyncExternalStore(subscribeVersion, () => version.n);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((peerKey: string | undefined) => contactFace(receivedOf(state?.links, peerKey), faceChoice(peerKey)), [state, v]);
}

/**
 * A chosen identity is on screen wherever the contact is (a chat row, the header), the way a card on screen is: its
 * profile is asked for there. The engine answers from its cache while the copy is fresh (a day) and shares one read
 * between askers, so this reaches the network at most once a day per chosen identity, and never for a contact
 * nobody chose a profile for.
 */
export function useChosenProfile(peerKey: string | undefined): void {
  const state = useEngineState();
  const choice = useFaceChoice(peerKey);
  const r = choice && choice !== "none" ? receivedOf(state?.links, peerKey)?.find(x => x.provider === choice.provider && x.subject === choice.subject) : undefined;
  const good = !!r && isGood(badgeState(r) ?? "expired") && hasPublicProfile(r.provider);
  const provider = r?.provider, subject = r?.subject;
  useEffect(() => {
    if (good && provider && subject) void engine.call("loadPublicProfile", { provider, subject }).catch(() => {});
  }, [good, provider, subject]);
}

/**
 * A group's roster with its members' names as their contacts are shown: a member who is also a contact, shown as one
 * of their identities, goes by that identity's name in the group's messages, events and mentions. A contact the user
 * gave a nickname keeps the name the group knows them by (the nickname wins over an identity, and groups do not show
 * nicknames). Members who are not contacts are unchanged.
 */
export function withContactFaces<G extends { members: { key: string; me: boolean; nick?: string }[]; memberLinks: Record<string, string> }>(
  group: G, links: LinkView[] | undefined, faceOf: (peerKey: string | undefined) => ContactFace | undefined, nicknameOf: (peerKey: string) => string | undefined,
): G {
  let changed = false;
  const members = group.members.map(m => {
    if (m.me) return m;
    const linkId = Object.keys(group.memberLinks).find(id => group.memberLinks[id] === m.key);
    const peerKey = linkId ? links?.find(l => l.id === linkId)?.peerPubKeyZ32 : undefined;
    const name = peerKey && !nicknameOf(peerKey) ? faceOf(peerKey)?.name : undefined;
    if (!name || name === m.nick) return m;
    changed = true;
    return { ...m, nick: name };
  });
  return changed ? { ...group, members } : group;
}
