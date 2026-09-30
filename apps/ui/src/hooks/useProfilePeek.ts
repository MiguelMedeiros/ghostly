import { useEffect, useRef } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { useServicesPlatform } from "./useServicesPlatform";
import { activeProfileId } from "../lib/profiles";
import { isDesktopApp } from "../lib/externalLink";
import { showPrivateNotification } from "../lib/notifications";
import { PROFILE_NOTICE, clearPeek, mutedInProfile, onBattery, peekEnabled, peekNotifies, peekTargets, startPeekLoop } from "../lib/profilePeek";

/** e2e: seconds between looks instead of minutes. */
const testPace = () => { try { return Number(localStorage.getItem("ghostly-test-peek-ms")) || undefined; } catch { return undefined; } };

/**
 * Checking the other profiles of this device for new messages (WISP 04 § Checking other profiles), while this
 * one runs. This profile forgets what was seen for it from elsewhere: it runs now, and fetches that itself.
 */
export function useProfilePeek(): void {
  const canSwitch = !!useServicesPlatform()?.features.profiles;
  const { settings } = useSettings();
  const { t } = useI18n();
  const latest = useRef({ settings, t });
  latest.current = { settings, t };
  useEffect(() => { clearPeek(activeProfileId()); }, []);
  useEffect(() => {
    if (!canSwitch) return;
    return startPeekLoop({
      call: (target) => engine.call("peekProfile", { profile: target.id, dbName: target.dbName }),
      targets: peekTargets,
      enabled: () => peekEnabled(latest.current.settings, isDesktopApp()),
      hidden: () => document.visibilityState === "hidden",
      onBattery,
      onFresh: (target, chats) => {
        const { settings: now, t: say } = latest.current;
        // Off by default; the system's Do Not Disturb holds it back like any other notice, and a chat muted in that profile stays quiet.
        if (!peekNotifies(now) || !now.notifications.systemEnabled || chats.every((chat) => mutedInProfile(target.id, chat))) return;
        void showPrivateNotification(`peek-${target.id || "default"}-${Date.now()}`, say("profilePeek.notice", { name: target.name }), `${PROFILE_NOTICE}${target.id}`);
      },
      testMs: testPace(),
    });
  }, [canSwitch]);
}
