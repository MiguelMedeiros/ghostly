import { useEffect, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";
import { useLockScreen } from "../contexts/LockScreenContext";
import { clearPendingSwitch, pendingSwitch, type PendingSwitch } from "../lib/profiles";

const subscribe = (listener: () => void) => engine.subscribe(listener);

/** The overlay's look, on its own so the entry points can show it before the app is there. */
export function ProfileSwitchView({ pending, arrived, leaving, label }: { pending: PendingSwitch; arrived?: boolean; leaving?: boolean; label: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="profile-switch-splash" data-leaving={leaving || undefined}
      className={`${arrived && !leaving ? "" : "profile-switch-splash "}fixed inset-0 z-[70] grid place-items-center bg-app-bg`}
      style={{ background: "var(--theme-app-bg, #222e35)" }}>
      <div className="flex flex-col items-center gap-4 px-6 text-center">
        <span className="profile-switch-badge grid place-items-center rounded-full overflow-hidden" style={{ width: 76, height: 76, boxShadow: `0 0 0 3px var(--theme-app-bg, #222e35), 0 0 0 6px ${pending.color}` }}>
          {pending.avatar
            ? <img src={pending.avatar} alt="" className="w-full h-full object-cover" />
            : <span aria-hidden="true" className="grid place-items-center w-full h-full text-[32px] font-semibold text-[#111b21]" style={{ background: pending.color }}>{pending.name.charAt(0).toUpperCase()}</span>}
        </span>
        <p className="text-lg font-semibold" style={{ color: "var(--theme-text-primary, #e9edef)" }}>{label}</p>
      </div>
    </div>
  );
}

/**
 * Switching profiles restarts the app on the other profile's storage (WISP 04). Instead of a blank page,
 * the profile being opened shows from the tap until its peer has started, or its lock screen is up: the
 * old page shows it until it reloads, the new one takes over from the same state and then lets go.
 */
export function ProfileSwitchSplash() {
  const { t } = useI18n();
  const { isLocked } = useLockScreen();
  const [arrived] = useState(() => !!pendingSwitch());
  const [pending, setPending] = useState<PendingSwitch | null>(() => pendingSwitch());
  const [leaving, setLeaving] = useState(false);
  const ready = useSyncExternalStore(subscribe, () => !!engine.state);

  useEffect(() => {
    const starting = (e: Event) => setPending((e as CustomEvent<PendingSwitch>).detail);
    window.addEventListener("profile-switching", starting);
    return () => window.removeEventListener("profile-switching", starting);
  }, []);
  // After the reload: gone once there is something to see (a moment, so it does not blink), or after 8 s whatever happens.
  useEffect(() => {
    if (!pending || !arrived || leaving) return;
    const timer = setTimeout(() => setLeaving(true), ready || isLocked ? 250 : 8000);
    return () => clearTimeout(timer);
  }, [pending, arrived, leaving, ready, isLocked]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => { clearPendingSwitch(); setPending(null); }, 180);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (!pending) return null;
  return <ProfileSwitchView pending={pending} arrived={arrived} leaving={leaving} label={t("profileSwitcher.switching", { name: pending.name })} />;
}
