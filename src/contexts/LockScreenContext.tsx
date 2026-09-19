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

interface LockScreenContextValue {
  isLocked: boolean;
  /** False until the password has been entered once since the app started: nothing of the app is rendered before that. */
  hasUnlocked: boolean;
  /** While failed attempts are being paced: when the next one is accepted. */
  retryAt: number | null;
  lock: () => void;
  unlock: (password: string) => Promise<boolean>;
  resetTimer: () => void;
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
  // Locked from the first render: a reload must not skip the password.
  const [isLocked, setIsLocked] = useState(lockActive);
  const [hasUnlocked, setHasUnlocked] = useState(!lockActive);
  const [retryAt, setRetryAt] = useState<number | null>(() => {
    const { retryAt } = loadAttempts();
    return retryAt > Date.now() ? retryAt : null;
  });
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
    <LockScreenContext.Provider value={{ isLocked, hasUnlocked, retryAt, lock, unlock, resetTimer }}>
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
