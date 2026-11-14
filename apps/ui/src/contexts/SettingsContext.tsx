import { getStorageProfile } from "../lib/storage";
import { knownDeviceGate } from "@ghostly/browser/devices/gate";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  loadSettings,
  saveSettingsChanges,
  sameSettings,
  settingsWithChanges,
  isSettingsStorageEvent,
  type AppSettings,
  type Theme,
  type ColorScheme,
  type ColorTheme,
  type Language,
  type ChatListDensity,
  type LockScreenSettings,
  type NotificationSettings,
} from "../lib/settings";
import { applyTextSize, type TextSize } from "../lib/textSize";
import { getRandomGhostName } from "../lib/storage";
import { cleanOwnName } from "../lib/ownName";

interface SettingsContextValue {
  settings: AppSettings;
  updateTheme: (theme: Theme) => void;
  updateColorScheme: (colorScheme: ColorScheme) => void;
  updateColorTheme: (colorTheme: ColorTheme) => void;
  updateLanguage: (language: Language) => void;
  updateLockScreen: (lockScreen: Partial<LockScreenSettings>) => void;
  updateNotifications: (notifications: Partial<NotificationSettings>) => void;
  updateDefaultNickname: (nickname: string) => void;
  updateReduceMotion: (reduce: boolean) => void;
  updateChatListDensity: (density: ChatListDensity) => void;
  updateTextSize: (size: TextSize) => void;
  updateChatListCollapsed: (collapsed: boolean) => void;
  updateCheckForUpdates: (check: boolean) => void;
  updateLinkPreviews: (on: boolean) => void;
  updateTranslateMessages: (on: boolean) => void;
  updateProfilePeek: (patch: NonNullable<AppSettings["profilePeek"]>) => void;
  randomizeNickname: () => void;
  resetSettings: () => void;
  /** Where this profile's backups go (WISP 1000). */
  updateBackupStorage: (patch: Pick<Partial<AppSettings>, "backupSpace" | "backupS3">) => void;
  /** Takes the settings as stored now, as another tab may have left them, and returns them. */
  followStored: () => AppSettings;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/** Translate received messages (Settings), on its own: every bubble reads it, and the whole settings drew them all. */
const TranslateMessagesContext = createContext(false);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  // The settings as this page last read or saved them. The extension runs the app in several tabs at once: a change
  // here is saved as a change over what is stored now, and what another tab saved is taken here as it lands.
  const synced = useRef(settings);

  useEffect(() => {
    if (settings === synced.current) return;
    // Not the active device for this profile (WISP 06 § The gate): its settings are part of a copy that stays as it
    // is. They are read (the language, the theme, the lock) and never written back.
    if (knownDeviceGate()?.full === false) return;
    const saved = saveSettingsChanges(synced.current, settings);
    // The saved copy is always a new object. It is taken only when it holds something another tab stored: otherwise
    // every reader of the settings would draw a second time for nothing.
    if (sameSettings(saved, settings)) {
      synced.current = settings;
      return;
    }
    synced.current = saved;
    setSettings(saved);
  }, [settings]);

  const followStored = useCallback(() => {
    const stored = loadSettings();
    const before = synced.current;
    synced.current = stored;
    // A change made here and not saved yet is kept, over what is stored.
    setSettings((current) => (current === before ? stored : settingsWithChanges(stored, before, current)));
    return stored;
  }, []);

  useEffect(() => {
    const stored = (event: StorageEvent) => {
      if (isSettingsStorageEvent(event)) followStored();
    };
    window.addEventListener("storage", stored);
    return () => window.removeEventListener("storage", stored);
  }, [followStored]);

  const updateTheme = useCallback((theme: Theme) => {
    setSettings((prev) => ({ ...prev, theme, colorScheme: theme }));
  }, []);

  const updateColorScheme = useCallback((colorScheme: ColorScheme) => {
    setSettings((prev) => ({ ...prev, colorScheme, theme: colorScheme }));
  }, []);

  const updateColorTheme = useCallback((colorTheme: ColorTheme) => {
    setSettings((prev) => ({ ...prev, colorTheme }));
  }, []);

  const updateLanguage = useCallback((language: Language) => {
    setSettings((prev) => ({ ...prev, language }));
  }, []);

  const updateLockScreen = useCallback(
    (lockScreen: Partial<LockScreenSettings>) => {
      setSettings((prev) => ({
        ...prev,
        lockScreen: { ...prev.lockScreen, ...lockScreen },
      }));
    },
    []
  );

  const updateNotifications = useCallback(
    (notifications: Partial<NotificationSettings>) => {
      setSettings((prev) => ({
        ...prev,
        notifications: { ...prev.notifications, ...notifications },
      }));
    },
    []
  );

  // Kept as contacts will show it (`cleanOwnName`): what a field shows as typed is its own draft (`useOwnNameField`).
  const updateDefaultNickname = useCallback((nickname: string) => {
    setSettings((prev) => ({ ...prev, defaultNickname: cleanOwnName(nickname) }));
  }, []);

  const updateReduceMotion = useCallback((reduce: boolean) => {
    setSettings((prev) => ({ ...prev, reduceMotion: reduce }));
  }, []);

  const updateChatListDensity = useCallback((chatListDensity: ChatListDensity) => {
    setSettings((prev) => ({ ...prev, chatListDensity }));
  }, []);

  const updateTextSize = useCallback((textSize: TextSize) => {
    setSettings((prev) => ({ ...prev, textSize }));
  }, []);

  const updateChatListCollapsed = useCallback((chatListCollapsed: boolean) => {
    setSettings((prev) => ({ ...prev, chatListCollapsed }));
  }, []);

  const updateCheckForUpdates = useCallback((check: boolean) => {
    setSettings((prev) => ({ ...prev, checkForUpdates: check }));
  }, []);

  const updateLinkPreviews = useCallback((linkPreviews: boolean) => {
    setSettings((prev) => ({ ...prev, linkPreviews }));
  }, []);

  const updateTranslateMessages = useCallback((translateMessages: boolean) => {
    setSettings((prev) => ({ ...prev, translateMessages }));
  }, []);

  const updateProfilePeek = useCallback((patch: NonNullable<AppSettings["profilePeek"]>) => {
    setSettings((prev) => ({ ...prev, profilePeek: { ...prev.profilePeek, ...patch } }));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(settings.reduceMotion);
  }, [settings.reduceMotion]);

  // Before the page is drawn: a chat opened at Huge is never drawn once at the default size first.
  useLayoutEffect(() => applyTextSize(settings.textSize), [settings.textSize]);

  const randomizeNickname = useCallback(() => {
    const randomName = getRandomGhostName();
    setSettings((prev) => ({ ...prev, defaultNickname: randomName }));
  }, []);

  const updateBackupStorage = useCallback((patch: Pick<Partial<AppSettings>, "backupSpace" | "backupS3">) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetSettings = useCallback(() => {
    const defaultSettings = loadSettings();
    localStorage.removeItem(getStorageProfile() ? `ghostly_${getStorageProfile()}_app_settings` : "ghostly_app_settings");
    setSettings(defaultSettings);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateTheme,
        updateColorScheme,
        updateColorTheme,
        updateLanguage,
        updateLockScreen,
        updateNotifications,
        updateDefaultNickname,
        updateReduceMotion,
        updateChatListDensity,
        updateTextSize,
        updateChatListCollapsed,
        updateCheckForUpdates,
        updateLinkPreviews,
        updateTranslateMessages,
        updateProfilePeek,
        randomizeNickname,
        resetSettings,
        updateBackupStorage,
        followStored,
      }}
    >
      <TranslateMessagesContext.Provider value={settings.translateMessages}>{children}</TranslateMessagesContext.Provider>
    </SettingsContext.Provider>
  );
}

/** `settings.translateMessages`, drawing again only when it changes, not on every other setting. */
export function useTranslateMessages(): boolean {
  return useContext(TranslateMessagesContext);
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
