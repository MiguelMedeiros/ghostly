import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import { updatePlatform, type FoundUpdate } from "../lib/updates";

/** How often a client that is allowed to ask does so on its own. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** Coming back to a tab that has been away this long is worth another look. */
const STALE_MS = 30 * 60 * 1000;
const DISMISSED_KEY = "ghostly_update_dismissed";

/** What was put aside. Not the version alone: the web app deploys the same version many times. */
function identify(update: FoundUpdate): string {
  return update.build ? `${update.version}+${update.build}` : update.version;
}

interface UpdateContextValue {
  /** Whether this client can learn about new versions at all. */
  supported: boolean;
  /** The newer version that was found, or null. */
  update: FoundUpdate | null;
  stage: "idle" | "checking" | "installing";
  /** 0 to 1 while an install that reports progress runs. */
  progress: number;
  error: string | null;
  lastCheckedAt: number | null;
  /** Whether the user put this version aside. Settings still shows it. */
  dismissed: boolean;
  downloadUrl: string;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * One update check for the whole app: the banner and Settings read the same
 * state, and nothing asks the network twice. Automatic checks only happen
 * while the setting allows them; the button in Settings always works.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [update, setUpdate] = useState<FoundUpdate | null>(null);
  const [stage, setStage] = useState<"idle" | "checking" | "installing">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissed);
  // A check in flight must not be started again by the interval or a tab coming back.
  const checking = useRef(false);
  // Read by the listeners below, which outlive the render that set it.
  const lastCheckedRef = useRef<number | null>(null);

  const check = useCallback(async () => {
    if (!updatePlatform || checking.current) return;
    checking.current = true;
    setStage("checking");
    setError(null);
    try {
      setUpdate(await updatePlatform.check());
      lastCheckedRef.current = Date.now();
      setLastCheckedAt(lastCheckedRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      checking.current = false;
      setStage("idle");
    }
  }, []);

  const install = useCallback(async () => {
    if (!updatePlatform || !update || update.apply === "manual") return;
    setStage("installing");
    setProgress(0);
    setError(null);
    try {
      // On the way out: this either reloads the page or restarts the app.
      await updatePlatform.install(update, setProgress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("idle");
    }
  }, [update]);

  const dismiss = useCallback(() => {
    if (!update) return;
    setDismissedVersion(identify(update));
    try {
      localStorage.setItem(DISMISSED_KEY, identify(update));
    } catch {
      // Storage full or unavailable: the banner comes back, which is the safe way to fail.
    }
  }, [update]);

  const allowed = settings.checkForUpdates && !!updatePlatform;

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    const run = () => {
      if (cancelled || !navigator.onLine) return;
      void check();
    };

    run();
    const interval = setInterval(run, CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const last = lastCheckedRef.current;
      if (last && Date.now() - last < STALE_MS) return;
      run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [allowed, check]);

  return (
    <UpdateContext.Provider
      value={{
        supported: !!updatePlatform,
        update,
        stage,
        progress,
        error,
        lastCheckedAt,
        dismissed: !!update && identify(update) === dismissedVersion,
        downloadUrl: updatePlatform?.downloadUrl ?? "",
        check,
        install,
        dismiss,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdate(): UpdateContextValue {
  const context = useContext(UpdateContext);
  if (!context) throw new Error("useUpdate must be used within an UpdateProvider");
  return context;
}
