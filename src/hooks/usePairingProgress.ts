import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { deriveStage, reportedProgress, type PairingProgress, type PairingRole, type PairingStage } from "../lib/pairingProgress";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** How long the "connected" moment stays before the chat takes over. */
export const CELEBRATE_MS = 1800;
/** A chat whose link is not in the engine yet is a new one only if it was made this recently. */
const NEW_CHAT_MS = 60 * 60_000;

export interface PairingProgressState extends PairingProgress {
  linkId?: string;
  /** Read off the link's other fields, because the engine does not report progress itself. */
  derived: boolean;
}

export interface PairingPresence {
  progress: PairingProgressState | null;
  /** The pairing scene belongs on screen: a first pairing not live yet, or its short "connected" moment. */
  show: boolean;
  celebrating: boolean;
  retry(): Promise<void>;
  retrying: boolean;
  retryError: string;
}

/**
 * The pairing progress of the paired chat with `peerKey`, and whether its scene is on. Only a chat's first
 * pairing gets the scene: a contact already paired reconnects under the header's connection control.
 */
export function usePairingProgress(peerKey: string | undefined, { inviter, enabled, createdAt }: { inviter: boolean; enabled: boolean; createdAt?: number }): PairingPresence {
  const state = useSyncExternalStore(subscribe, snapshot);
  const link = peerKey ? state?.links.find(l => l.peerPubKeyZ32 === peerKey) : undefined;
  const reported = reportedProgress(link);
  const online = state?.settings.online ?? true;

  // Everything latched below belongs to one chat: another chat in this place starts over.
  const owner = useRef(peerKey);
  const role = useRef<PairingRole | null>(null);
  const first = useRef<boolean | null>(null);
  const since = useRef<{ stage: PairingStage; at: number; linked: boolean } | null>(null);
  const wasLive = useRef<boolean | null>(null);
  if (owner.current !== peerKey) { owner.current = peerKey; role.current = first.current = since.current = wasLive.current = null; }

  // The role is what this device did first; the invite code is forgotten once the contact shows up.
  role.current ??= reported?.role ?? (inviter ? "inviter" : "joiner");

  // Decided once the link is there to decide from: never paired yet. Until then (a chat just joined), a new chat is.
  if (first.current === null && enabled && link) first.current = !link.peerParticipationKey;
  const firstPairing = first.current ?? (!!state && Date.now() - (createdAt ?? Date.now()) < NEW_CHAT_MS);

  const derived = deriveStage(link, reported?.role ?? role.current, online);
  const stage: PairingStage = reported?.stage ?? derived.stage;
  const mounted = useRef(Date.now());
  if (!reported && (since.current?.stage !== stage || (link && !since.current.linked))) {
    // The first stage seen on the link began when the link did; later ones begin when they are seen.
    since.current = { stage, linked: !!link, at: since.current?.linked ? Date.now() : link?.createdAt || mounted.current };
  }
  const [attempt, setAttempt] = useState(1);

  const [celebrating, setCelebrating] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { setCelebrating(false); setDone(false); setAttempt(1); }, [peerKey]);
  useEffect(() => {
    if (!enabled || !firstPairing) return;
    const live = stage === "live";
    if (wasLive.current === false && live) setCelebrating(true);
    else if (wasLive.current === null && live) setDone(true);
    wasLive.current = live;
  }, [enabled, firstPairing, stage]);
  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(() => { setCelebrating(false); setDone(true); }, CELEBRATE_MS);
    return () => window.clearTimeout(timer);
  }, [celebrating]);

  const [retrying, setRetrying] = useState(false), [retryError, setRetryError] = useState("");
  const linkId = link?.id;
  const retry = useCallback(async () => {
    if (!linkId) return;
    setRetrying(true); setRetryError(""); setAttempt(n => n + 1);
    try { await engine.call("connect", { linkId }); }
    catch (cause) { setRetryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRetrying(false); }
  }, [linkId]);

  if (!enabled) return { progress: null, show: false, celebrating: false, retry, retrying, retryError };
  const progress: PairingProgressState = reported
    ? { ...reported, linkId, derived: false }
    : { role: role.current, ...derived, since: since.current!.at, startedAt: link?.createdAt || mounted.current, attempt, linkId, derived: true };
  const show = firstPairing && !done && (stage !== "live" || celebrating);
  return { progress, show, celebrating, retry, retrying, retryError };
}

/** The clock, once a second while `running`: for elapsed times that tick on screen. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}
