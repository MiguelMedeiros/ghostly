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
import { verifyPassword } from "../lib/settings";

interface LockScreenContextValue {
  isLocked: boolean;
  lock: () => void;
  unlock: (password: string) => Promise<boolean>;
  resetTimer: () => void;
}

const LockScreenContext = createContext<LockScreenContextValue | null>(null);

export function LockScreenProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [isLocked, setIsLocked] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  const lock = useCallback(() => {
    if (settings.lockScreen.enabled && settings.lockScreen.passwordHash) {
      setIsLocked(true);
    }
  }, [settings.lockScreen.enabled, settings.lockScreen.passwordHash]);

  const unlock = useCallback(
    async (password: string): Promise<boolean> => {
      if (!settings.lockScreen.passwordHash) return true;
      const valid = await verifyPassword(
        password,
        settings.lockScreen.passwordHash
      );
      if (valid) {
        setIsLocked(false);
        lastActivityRef.current = Date.now();
      }
      return valid;
    },
    [settings.lockScreen.passwordHash]
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
    <LockScreenContext.Provider value={{ isLocked, lock, unlock, resetTimer }}>
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
