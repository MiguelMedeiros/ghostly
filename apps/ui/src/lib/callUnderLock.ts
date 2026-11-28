import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * A call on while the app is locked, as the lock screen may show it (WISP 601 § Locked): who it is with, as the chat's
 * header shows them (the contact face rules, or the group's name and picture), how long it has lasted, and the two
 * things it can do without the password, Mute and End call. Nothing else of the chat.
 */
export interface CallUnderLock {
  /** The chat's session id, or the group's id. */
  id: string;
  name: string;
  /** False when the contact has no name: the picture is then a pattern of their key, as in the chat. */
  named: boolean;
  peerPubKey?: string;
  /** The picture of the identity the contact is shown as, or the group's. */
  photo?: string;
  /** A group's call: its picture is the group's, and End call leaves it. */
  group?: boolean;
  /** Ringing out, connecting (answered, or joining a group's), connected, or connected with its path lost. */
  state: "calling" | "connecting" | "connected" | "reconnecting";
  /** When it connected, by the device's clock: the lock screen counts its time from then. */
  startedAt: number | null;
  muted: boolean;
  /** The call's own Mute, as its window's button. */
  toggleMute: () => void;
  /** The call's own hang-up (a group's: Leave call), as its window's button. */
  end: () => void;
}

const calls = new Map<string, CallUnderLock>();
let shown: readonly CallUnderLock[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  shown = [...calls.values()];
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const NONE: readonly CallUnderLock[] = [];

/** A call's length as its window shows it: `mm:ss`, or `h:mm:ss` past the hour (an hour and five minutes read 1:05:00). */
export function callTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mmss = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** The calls on now, oldest first: while locked, the lock screen shows the first one. */
export function useCallsUnderLock(): readonly CallUnderLock[] {
  return useSyncExternalStore(subscribe, () => shown, () => NONE);
}

/**
 * Tells the lock screen that this chat's call is on (`call`), or no longer (null). Registered again only when what the
 * screen shows changes; `toggleMute` and `end` are read when pressed, so a call that ended meanwhile does nothing more
 * than its own buttons would.
 */
export function useCallOnLockScreen(call: CallUnderLock | null): void {
  const latest = useRef(call);
  latest.current = call;
  const key = call ? JSON.stringify([call.id, call.name, call.named, call.peerPubKey, call.photo, call.group, call.state, call.startedAt, call.muted]) : null;
  const id = call?.id;
  useEffect(() => {
    const now = latest.current;
    if (!key || !id || !now) return;
    calls.set(id, { ...now, toggleMute: () => latest.current?.toggleMute(), end: () => latest.current?.end() });
    changed();
    return () => {
      calls.delete(id);
      changed();
    };
  }, [key, id]);
}
