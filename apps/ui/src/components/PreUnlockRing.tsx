import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useLockScreen } from "../contexts/LockScreenContext";
import { offerSession } from "../lib/lockedRing";
import { Chat } from "../pages/Chat";
import { useLimited } from "./devices/LimitedStart";

/** A chat that never rings is let go, as App lets go of one (its loaded chats). */
const NEVER_RANG_MS = 15_000;
/** One whose call ended stays a little: a compatibility chat sends its decline on its next poll. */
const LINGER_MS = 10_000;

const subscribe = (listener: () => void) => engine.subscribe(listener);
const startFailed = () => !!engine.startFailure;

/**
 * Before the password has been entered once, nothing of the app is drawn, chats included; but the peer runs, and a
 * call can come in. That chat alone is loaded, only while it rings, and draws nothing (no message, preview or
 * name): it rings as it would unlocked, and the lock screen shows who calls (WISP 601 § Locked). Answer hands the call
 * over to the chat the app opens once unlocked (`holdForUnlock`). Not for a profile whose peer did not start or that
 * asks first which device is active (WISP 06): those show nothing either.
 */
export function PreUnlockRing() {
  const { hasUnlocked } = useLockScreen();
  const failed = useSyncExternalStore(subscribe, startFailed);
  const limited = useLimited() === "ask";
  return hasUnlocked || failed || limited ? null : <RingingChats />;
}

function RingingChats() {
  const [held, setHeld] = useState<readonly string[]>([]);
  const rang = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const letGo = useCallback((sessionId: string, after: number, unless: () => boolean) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (!unless()) setHeld((current) => current.filter((id) => id !== sessionId));
    }, after);
    timers.current.add(timer);
  }, []);

  useEffect(() => engine.onCallSignal((linkId, signal) => {
    const session = offerSession(linkId, signal);
    if (!session) return;
    setHeld((current) => (current.includes(session) ? current : [...current, session]));
    letGo(session, NEVER_RANG_MS, () => rang.current.has(session));
  }), [letGo]);

  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of pending) clearTimeout(timer); };
  }, []);

  const onCallChange = useCallback((sessionId: string, onCall: boolean) => {
    if (onCall) { rang.current.add(sessionId); return; }
    if (!rang.current.delete(sessionId)) return;
    letGo(sessionId, LINGER_MS, () => rang.current.has(sessionId));
  }, [letGo]);

  if (!held.length) return null;
  return (
    <div hidden inert aria-hidden="true" data-testid="pre-unlock-ring">
      {held.map((id) => (
        <Chat key={id} sessionId={id} visible={false} onCallChange={onCallChange} callLayer={null} holdForUnlock />
      ))}
    </div>
  );
}
