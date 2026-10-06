import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import { hashPassword, needsRehash, verifyPassword } from "../lib/settings";
import { activeProfileId } from "../lib/profiles";
import { takeUnlockHandover } from "../lib/lockHandover";

interface LockScreenContextValue {
  isLocked: boolean;
  /** False until the password has been entered once since the app started: nothing of the app is rendered before that. */
  hasUnlocked: boolean;
  /** While failed attempts are being paced: when the next one is accepted. */
  retryAt: number | null;
  lock: () => void;
  unlock: (password: string) => Promise<boolean>;
  resetTimer: () => void;
  /** Calls ringing now, oldest first: while locked, the lock screen shows the first one (WISP 601 § Locked). */
  ringing: readonly LockedCall[];
  /** A chat says its call rings; the function it returns says it stopped. */
  offerCall: (call: LockedCall) => () => void;
}

/**
 * A call ringing in a chat, as the lock screen may show it: who calls, as the chat shows them (the contact face rules),
 * and the two things it can do. Nothing else of the chat.
 */
export interface LockedCall {
  /** The chat's session id. */
  id: string;
  name: string;
  /** False when the contact has no name: the picture is then a pattern of their key, as in the chat. */
  named: boolean;
  peerPubKey?: string;
  /** The picture of the identity the contact is shown as, when there is one. */
  photo?: string;
  hasVideo: boolean;
  /** Ends the other call first when one is on ("End and answer"). */
  onCall: boolean;
  /** Answers as the call came: with the camera for a video call. */
  answer: () => void;
  decline: () => void;
}

const LockScreenContext = createContext<LockScreenContextValue | null>(null);

// Kept across reloads, or reloading would reset the pacing.
const ATTEMPTS_KEY = "ghostly_lock_attempts";
/** Failures allowed before the wait starts; then it doubles from 1 s, up to 5 minutes. */
const FREE_ATTEMPTS = 3;
const MAX_DELAY_MS = 5 * 60_000;

interface Attempts {
  failures: number;
  retryAt: number;
}

function loadAttempts(): Attempts {
  try {
    const parsed = JSON.parse(localStorage.getItem(ATTEMPTS_KEY) ?? "") as Partial<Attempts>;
    return { failures: Number(parsed.failures) || 0, retryAt: Number(parsed.retryAt) || 0 };
  } catch {
    return { failures: 0, retryAt: 0 };
  }
}

function saveAttempts(attempts: Attempts | null): void {
  try {
    if (attempts) localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
    else localStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    // storage unavailable
  }
}

export function LockScreenProvider({ children }: { children: ReactNode }) {
  const { settings, updateLockScreen } = useSettings();
  const lockActive = settings.lockScreen.enabled && !!settings.lockScreen.passwordHash;
  // Locked from the first render: a reload must not skip the password, unless the app handed the lock it passed across.
  const [handed] = useState(() => lockActive && takeUnlockHandover(activeProfileId(), settings.lockScreen.passwordHash));
  const [isLocked, setIsLocked] = useState(lockActive && !handed);
  const [hasUnlocked, setHasUnlocked] = useState(!lockActive || handed);
  const [retryAt, setRetryAt] = useState<number | null>(() => {
    const { retryAt } = loadAttempts();
    return retryAt > Date.now() ? retryAt : null;
  });
  const [ringing, setRinging] = useState<readonly LockedCall[]>([]);
  const offerCall = useCallback((call: LockedCall) => {
    setRinging((current) => [...current.filter((c) => c.id !== call.id), call]);
    return () => setRinging((current) => current.filter((c) => c !== call));
  }, []);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  const lock = useCallback(() => {
    if (settings.lockScreen.enabled && settings.lockScreen.passwordHash) {
      setIsLocked(true);
    }
  }, [settings.lockScreen.enabled, settings.lockScreen.passwordHash]);

  const unlock = useCallback(
    async (password: string): Promise<boolean> => {
      const storedHash = settings.lockScreen.passwordHash;
      if (!storedHash) return true;

      const attempts = loadAttempts();
      if (attempts.retryAt > Date.now()) {
        setRetryAt(attempts.retryAt);
        return false;
      }

      const valid = await verifyPassword(password, storedHash);
      if (!valid) {
        const failures = attempts.failures + 1;
        const delay =
          failures < FREE_ATTEMPTS ? 0 : Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - FREE_ATTEMPTS));
        const next = delay ? Date.now() + delay : 0;
        saveAttempts({ failures, retryAt: next });
        setRetryAt(next || null);
        return false;
      }

      saveAttempts(null);
      setRetryAt(null);
      setIsLocked(false);
      setHasUnlocked(true);
      lastActivityRef.current = Date.now();
      // Older, weaker hashes are replaced now that the password is known.
      if (needsRehash(storedHash)) {
        updateLockScreen({ passwordHash: await hashPassword(password) });
      }
      return true;
    },
    [settings.lockScreen.passwordHash, updateLockScreen]
  );

  const resetTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (
      settings.lockScreen.enabled &&
      settings.lockScreen.passwordHash &&
      !isLocked
    ) {
      timerRef.current = setTimeout(() => {
        lock();
      }, settings.lockScreen.timeoutMinutes * 60 * 1000);
    }
  }, [
    settings.lockScreen.enabled,
    settings.lockScreen.passwordHash,
    settings.lockScreen.timeoutMinutes,
    isLocked,
    lock,
  ]);

  useEffect(() => {
    if (!settings.lockScreen.enabled || !settings.lockScreen.passwordHash) {
      setIsLocked(false);
      setHasUnlocked(true);
      return;
    }

    const handleActivity = () => {
      if (!isLocked) {
        resetTimer();
      }
    };

    const events = ["mousedown", "keydown", "touchstart", "mousemove"];
    events.forEach((event) => {
      window.addEventListener(event, handleActivity, { passive: true });
    });

    resetTimer();

    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, handleActivity);
      });
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [
    settings.lockScreen.enabled,
    settings.lockScreen.passwordHash,
    isLocked,
    resetTimer,
  ]);

  return (
    <LockScreenContext.Provider value={{ isLocked, hasUnlocked, retryAt, lock, unlock, resetTimer, ringing, offerCall }}>
      {children}
    </LockScreenContext.Provider>
  );
}

export function useLockScreen(): LockScreenContextValue {
  const context = useContext(LockScreenContext);
  if (!context) {
    throw new Error("useLockScreen must be used within a LockScreenProvider");
  }
  return context;
}

/** Whether the lock screen is up; false where there is none (a part rendered on its own). */
export function useIsLocked(): boolean {
  return useContext(LockScreenContext)?.isLocked ?? false;
}

/**
 * Tells the lock screen that this chat's call rings (`call`), or that it no longer does (null). Registered again only
 * when what the screen shows changes; `answer` and `decline` are read when pressed, so a call that ended meanwhile does
 * nothing.
 */
export function useRingOnLockScreen(call: LockedCall | null): void {
  const offerCall = useContext(LockScreenContext)?.offerCall;
  const latest = useRef(call);
  latest.current = call;
  const key = call ? JSON.stringify([call.id, call.name, call.named, call.peerPubKey, call.photo, call.hasVideo, call.onCall]) : null;
  useEffect(() => {
    const shown = latest.current;
    if (!offerCall || !key || !shown) return;
    return offerCall({ ...shown, answer: () => latest.current?.answer(), decline: () => latest.current?.decline() });
  }, [offerCall, key]);
}
