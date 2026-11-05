import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { getBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { useSettings } from "./SettingsContext";
import { hashPassword, needsRehash, verifyPassword } from "../lib/settings";
import { activeProfileId } from "../lib/profiles";
import { takeUnlockHandover } from "../lib/lockHandover";
import { onAppInput, stopRunningApps } from "../lib/apps/open";
import { closeServiceWindows } from "../lib/serviceWindows";
import { pauseForLock } from "../lib/nowPlaying";

interface LockScreenContextValue {
  isLocked: boolean;
  /** False until the password has been entered once since the app started: nothing of the app is rendered before that. */
  hasUnlocked: boolean;
  /** The app is away (hidden, or on a phone not the focused window) with the lock on: a plain cover hides its content. */
  covered: boolean;
  /** Whether the lock stands passed right now: open, and its time away not up even if no timer has said so yet. */
  passedNow: () => boolean;
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
/** The longest wait between two looks at the clock while unlocked (see `checkIdle`). */
const LOCK_CHECK_MS = 30_000;
/** The channel the app's pages of one origin hear Lock Now on (`lock`). */
const LOCK_CHANNEL = "ghostly-lock";

/**
 * Away as the system's app switcher sees it: hidden, or on a phone no longer the focused window (Android's recents
 * take their picture before the page is hidden). Focus moving into a frame of this page is not away.
 */
function awayFromSwitcher(): boolean {
  if (document.visibilityState === "hidden") return true;
  if (document.hasFocus() || document.activeElement instanceof HTMLIFrameElement) return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

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

/** The Web Lock the app's pages of one origin take turns on to try a password (`unlock`). */
const ATTEMPTS_LOCK = "ghostly-unlock";

/**
 * Runs one try at the password while no other page of the app runs one: the extension opens the app in as many tabs
 * as one likes, and tries made in them at once would otherwise all read the same count and fit in one paced slot.
 */
function oneTryAtATime(run: () => Promise<boolean>): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return typeof locks?.request === "function" ? locks.request(ATTEMPTS_LOCK, run).then((valid) => valid) : run();
}

export function LockScreenProvider({ children }: { children: ReactNode }) {
  const { settings, updateLockScreen, followStored } = useSettings();
  const lockActive = settings.lockScreen.enabled && !!settings.lockScreen.passwordHash;
  // Locked from the first render: a reload must not skip the password, unless the app handed the lock it passed across.
  const [handed] = useState(() => lockActive && takeUnlockHandover(activeProfileId(), settings.lockScreen.passwordHash));
  const [isLocked, setIsLocked] = useState(lockActive && !handed);
  const [hasUnlocked, setHasUnlocked] = useState(!lockActive || handed);
  const [retryAt, setRetryAt] = useState<number | null>(() => {
    const { retryAt } = loadAttempts();
    return retryAt > Date.now() ? retryAt : null;
  });
  const [covered, setCovered] = useState(false);
  const [ringing, setRinging] = useState<readonly LockedCall[]>([]);
  const offerCall = useCallback((call: LockedCall) => {
    setRinging((current) => [...current.filter((c) => c.id !== call.id), call]);
    return () => setRinging((current) => current.filter((c) => c !== call));
  }, []);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const checkIdleRef = useRef<() => void>(() => {});

  // The apps running (Desktop's windows of their own, the web's frames under the lock) stop when it locks: their
  // brokers would go on answering behind it. So do the windows of contacts' apps (Desktop), which this page serves.
  // A voice message, audio file or video playing pauses, and the system's media controls let go of it: the app stays
  // mounted under the lock (a call goes on), and they would go on playing it aloud and driving it from the lock screen.
  useEffect(() => {
    if (!isLocked) return;
    stopRunningApps();
    closeServiceWindows();
    pauseForLock();
  }, [isLocked]);

  // Android's app switcher takes its picture of the app before the page hears it is going, so the cover below comes
  // too late for it: while the lock is on, the app keeps out of that picture altogether (the host, where it can).
  useEffect(() => {
    let host: BrowserHost;
    try { host = getBrowserHost(); } catch { return; }
    void host.hideFromSwitcher?.(lockActive).catch(() => {});
  }, [lockActive]);

  // The lock as stored, not as this page last had it: a password set in another tab locks this one too.
  const lockHere = useCallback(() => {
    const { enabled, passwordHash } = followStored().lockScreen;
    if (enabled && passwordHash) {
      setIsLocked(true);
    }
  }, [followStored]);

  // The extension runs the app in several tabs at once: Lock Now in one locks them all, or the next tab would show
  // the chats to whoever clicks it. Only locking spreads; each tab is unlocked with the password on its own. The time
  // away is each tab's own (a tab left behind locks without locking the one in use).
  const lockChannel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(LOCK_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "lock") lockHere();
    };
    lockChannel.current = channel;
    return () => {
      channel.close();
      lockChannel.current = null;
    };
  }, [lockHere]);

  const lock = useCallback(() => {
    lockHere();
    lockChannel.current?.postMessage("lock");
  }, [lockHere]);

  const unlock = useCallback(
    async (password: string): Promise<boolean> => {
      const storedHash = settings.lockScreen.passwordHash;
      if (!storedHash) return true;

      const valid = await oneTryAtATime(async () => {
        const attempts = loadAttempts();
        if (attempts.retryAt > Date.now()) {
          setRetryAt(attempts.retryAt);
          return false;
        }

        // The try is counted as a failure, and the next wait set, before the check: a try started meanwhile where
        // there are no Web Locks finds the slot taken. A right password gives it back.
        const failures = attempts.failures + 1;
        const delay =
          failures < FREE_ATTEMPTS ? 0 : Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - FREE_ATTEMPTS));
        const next = delay ? Date.now() + delay : 0;
        saveAttempts({ failures, retryAt: next });
        if (await verifyPassword(password, storedHash)) {
          saveAttempts(null);
          return true;
        }
        setRetryAt(next || null);
        return false;
      });
      if (!valid) return false;

      setRetryAt(null);
      setCovered(false);
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

  const timeoutMs = settings.lockScreen.timeoutMinutes * 60 * 1000;

  const lockedNow = useRef(isLocked);
  lockedNow.current = isLocked;
  const passedNow = useCallback(() => !lockedNow.current && Date.now() - lastActivityRef.current < timeoutMs, [timeoutMs]);

  // The time away is read from the clock, not left to one timer: a timer's clock stands still while the device sleeps
  // (a phone with the screen off, a suspended laptop), so a timer alone would bring the app back unlocked after hours
  // away. Locks when the time since the last activity is up; otherwise looks again when it would be, and at least
  // every LOCK_CHECK_MS, which is how long a device that woke with nobody touching it may stay unlocked.
  const checkIdle = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!settings.lockScreen.enabled || !settings.lockScreen.passwordHash || isLocked) return;
    const now = Date.now();
    // A clock set back must not make the wait longer than the chosen time.
    if (lastActivityRef.current > now) lastActivityRef.current = now;
    const left = lastActivityRef.current + timeoutMs - now;
    if (!(left > 0)) {
      lockHere();
      return;
    }
    timerRef.current = setTimeout(() => checkIdleRef.current(), Math.min(left, LOCK_CHECK_MS));
  }, [settings.lockScreen.enabled, settings.lockScreen.passwordHash, timeoutMs, isLocked, lockHere]);
  checkIdleRef.current = checkIdle;

  const resetTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    checkIdle();
  }, [checkIdle]);

  useEffect(() => {
    if (!settings.lockScreen.enabled || !settings.lockScreen.passwordHash) {
      setIsLocked(false);
      setHasUnlocked(true);
      setCovered(false);
      return;
    }

    // The system keeps a picture of the last screen for its app switcher, and a hidden page can't draw it again when
    // the lock comes on: the cover is drawn as the app goes, at once (`flushSync`), before the picture is taken.
    const coverNow = () => flushSync(() => setCovered(true));
    const cover = () => {
      if (awayFromSwitcher()) coverNow();
    };
    // It goes only once `checkIdle` has decided, in the same render: to the lock screen, or back to the content.
    const uncover = () => {
      if (!awayFromSwitcher()) setCovered(false);
    };

    // The first touch after too long away locks; it does not start the time again with the chats on screen.
    const handleActivity = () => {
      if (isLocked) return;
      if (Date.now() - lastActivityRef.current < timeoutMs) lastActivityRef.current = Date.now();
      checkIdle();
      uncover();
    };
    // Coming back (the Android app says so through `visibilitychange`, `followAppVisibility`) is not activity.
    const handleReturn = () => {
      checkIdle();
      uncover();
    };
    const handleVisibility = () => (document.visibilityState === "hidden" ? coverNow() : handleReturn());

    const events = ["mousedown", "keydown", "touchstart", "mousemove"];
    events.forEach((event) => {
      window.addEventListener(event, handleActivity, { passive: true });
    });
    // Taps and keys in an app the person is in: its frame or window keeps them from this page.
    const stopAppInput = onAppInput(handleActivity);
    const returns = ["focus", "pageshow"];
    returns.forEach((event) => window.addEventListener(event, handleReturn));
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", coverNow);
    window.addEventListener("blur", cover);

    resetTimer();

    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, handleActivity);
      });
      stopAppInput();
      returns.forEach((event) => window.removeEventListener(event, handleReturn));
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", coverNow);
      window.removeEventListener("blur", cover);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [
    settings.lockScreen.enabled,
    settings.lockScreen.passwordHash,
    timeoutMs,
    isLocked,
    checkIdle,
    resetTimer,
  ]);

  return (
    <LockScreenContext.Provider value={{ isLocked, hasUnlocked, covered, passedNow, retryAt, lock, unlock, resetTimer, ringing, offerCall }}>
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

const NOT_PASSED = () => false;

/**
 * Asks, when called, whether this page may carry the lock across a reload (`reloadIntoGate`). Read at the moment of the
 * reload, never from a render before it: a takeover's check takes half a minute. False where there is no lock screen.
 */
export function useLockPassedNow(): () => boolean {
  return useContext(LockScreenContext)?.passedNow ?? NOT_PASSED;
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
