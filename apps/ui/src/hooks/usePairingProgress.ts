import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { contactArrived, deriveStage, pairingView, reportedProgress, stepIndex, type PairingProgress, type PairingRole, type PairingStage } from "../lib/pairingProgress";
import { loadSettings } from "../lib/settings";
import { playSound } from "../lib/sounds";
import { errorText } from "../lib/errorText";
import { useT } from "../contexts/I18nContext";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** How long the "connected" moment stays before the chat takes over. The chat is live, and usable, all along. */
export const CELEBRATE_MS = 1800;
/** A chat whose link is not in the engine yet is a new one only if it was made this recently. */
const NEW_CHAT_MS = 60 * 60_000;

export interface PairingProgressState extends PairingProgress {
  linkId?: string;
  /** Read off the link's other fields, because the engine does not report progress itself. */
  derived: boolean;
  /**
   * What the scene and the connection icon both show (`pairingView`): the stage in words and the step reached, which
   * only moves forward. `stage` above is the engine's, which steps back between attempts.
   */
  view: { stage: PairingStage; step: number };
}

export interface PairingPresence {
  progress: PairingProgressState | null;
  /** A first pairing not live yet, or its short "connected" moment: the connection icon tells the pairing. */
  show: boolean;
  /**
   * The scene itself is on: `show`, until the pairing goes on the DHT, where the chat takes over (WISP 400). It does not
   * come back: a live link that comes up later is the chat's connection, told by the icon and the timeline.
   */
  scene: boolean;
  celebrating: boolean;
  retry(): Promise<void>;
  retrying: boolean;
  retryError: string;
}

/**
 * The pairing progress of the paired chat with `peerKey`, and whether its scene is on. Only a chat's first
 * pairing gets the scene: a contact already paired reconnects under the header's connection control. The
 * scene's "connected" moment comes with one short sound, unless sounds are off, or `muted` for this chat.
 */
export function usePairingProgress(peerKey: string | undefined, { inviter, enabled, createdAt, muted = false }: { inviter: boolean; enabled: boolean; createdAt?: number; muted?: boolean }): PairingPresence {
  const t = useT();
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
  const shown = useRef(false);
  const celebrated = useRef(false);
  /** Until when the "connected" moment shows (ms since the epoch), decided in the render that sees live. */
  const celebrateUntil = useRef<number | null>(null);
  /** The first pairing went live in front of this page: the connected sound is owed. */
  const soundOwed = useRef(false);
  /** The pairing went on the DHT: the chat took over from the scene. */
  const aside = useRef(false);
  /** The furthest step shown: the scene and the icon never step back. */
  const reached = useRef(-1);
  if (owner.current !== peerKey) {
    owner.current = peerKey;
    role.current = first.current = since.current = wasLive.current = celebrateUntil.current = null;
    shown.current = celebrated.current = soundOwed.current = aside.current = false;
    reached.current = -1;
  }

  // The role is what this device did first; the invite code is forgotten once the contact shows up.
  role.current ??= reported?.role ?? (inviter ? "inviter" : "joiner");

  // Decided once the link is there to decide from: never paired yet. Until then (a chat just joined), a new chat is,
  // and a scene already on stays on: a fast handshake can pin the contact before the link reaches this page.
  const provisional = !!state && Date.now() - (createdAt ?? Date.now()) < NEW_CHAT_MS;
  if (first.current === null && enabled && link) first.current = shown.current || !link.peerParticipationKey;
  const firstPairing = first.current ?? provisional;
  if (!link && firstPairing) shown.current = true;

  const derived = deriveStage(link, reported?.role ?? role.current, online);
  const stage: PairingStage = reported?.stage ?? derived.stage;
  const mounted = useRef(Date.now());
  if (!reported && (since.current?.stage !== stage || (link && !since.current.linked))) {
    // The first stage seen on the link began when the link did; later ones begin when they are seen.
    since.current = { stage, linked: !!link, at: since.current?.linked ? Date.now() : link?.createdAt || mounted.current };
  }
  const [attempt, setAttempt] = useState(1);
  useEffect(() => { setAttempt(1); }, [peerKey]);

  // Decided in the render that sees the stage, not in an effect after it: a scene that waited for an effect to say
  // "celebrating" was gone for a frame when the pairing went live and then came back, its words and motion restarted.
  if (enabled && firstPairing) {
    const live = stage === "live";
    if (stage === "on-dht") aside.current = true;
    // The connected moment comes once, when the first pairing goes live in front of this page. Live already when the
    // chat opened (a restart), or live again after a drop or a transport switch: connection state, quiet like its
    // timeline. A pairing on the DHT gave the chat back already: its first live link is heard, and the scene stays away.
    if (live && !celebrated.current) {
      celebrated.current = true;
      const fresh = wasLive.current === false;
      soundOwed.current = fresh;
      celebrateUntil.current = fresh && !aside.current ? Date.now() + CELEBRATE_MS : null;
    }
    wasLive.current = live;
  }
  const until = celebrateUntil.current;
  // The timer ends the moment, not a reading of the clock: a timer can fire a moment before Date.now() reaches `until`,
  // and a moment read as not over yet would then stay until something else made the chat render again.
  const [ended, setEnded] = useState<number | null>(null);
  useEffect(() => {
    if (until === null) return;
    const timer = window.setTimeout(() => setEnded(until), Math.max(0, until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [until]);
  // Heard as the scene bursts: in the commit that shows it. Reduced motion stills the scene, not the sound: that is the
  // sound setting's.
  useEffect(() => {
    if (!soundOwed.current) return;
    soundOwed.current = false;
    if (!muted && loadSettings().notifications.soundEnabled) playSound("connected");
  });
  const celebrating = until !== null && ended !== until;
  const done = celebrated.current && !celebrating;

  const base: PairingProgress = reported
    ?? { role: role.current, ...derived, since: since.current!.at, startedAt: link?.createdAt || mounted.current, attempt };
  // An engine that reports no progress can lose the contact again (its packet went stale): the invite card comes back
  // (`contactArrived`), and the steps go back to the wait with it rather than say the contact is still there.
  if (!contactArrived(base)) reached.current = Math.min(reached.current, stepIndex(base.role, base.stage, base.peerSeen));
  const view = pairingView(base.role, base.stage, base.peerSeen, reached.current);
  reached.current = view.step;

  const [retrying, setRetrying] = useState(false), [retryError, setRetryError] = useState("");
  const linkId = link?.id;
  const retry = useCallback(async () => {
    if (!linkId) return;
    setRetrying(true); setRetryError(""); setAttempt(n => n + 1);
    try { await engine.call("connect", { linkId }); }
    catch (cause) { setRetryError(errorText(cause, t)); }
    finally { setRetrying(false); }
  }, [linkId, t, setAttempt]);

  if (!enabled) return { progress: null, show: false, scene: false, celebrating: false, retry, retrying, retryError };
  const progress: PairingProgressState = { ...base, linkId, derived: !reported, view };
  const show = firstPairing && !done && (stage !== "live" || celebrating);
  return { progress, show, scene: show && stage !== "on-dht" && !aside.current, celebrating, retry, retrying, retryError };
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
