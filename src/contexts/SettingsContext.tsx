import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  loadSettings,
  saveSettings,
  type AppSettings,
  type Theme,
  type ColorScheme,
  type ColorTheme,
  type Language,
  type LockScreenSettings,
  type NotificationSettings,
} from "../lib/settings";
import { getRandomGhostName } from "../lib/storage";

interface SettingsContextValue {
  settings: AppSettings;
  updateTheme: (theme: Theme) => void;
  updateColorScheme: (colorScheme: ColorScheme) => void;
  updateColorTheme: (colorTheme: ColorTheme) => void;
  updateLanguage: (language: Language) => void;
  updateLockScreen: (lockScreen: Partial<LockScreenSettings>) => void;
  updateNotifications: (notifications: Partial<NotificationSettings>) => void;
  updateDefaultNickname: (nickname: string) => void;
  updateGiphyApiKey: (key: string) => void;
  updateReduceMotion: (reduce: boolean) => void;
  updateCheckForUpdates: (check: boolean) => void;
  randomizeNickname: () => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings(getRandomGhostName));

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

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

  const updateDefaultNickname = useCallback((nickname: string) => {
    setSettings((prev) => ({ ...prev, defaultNickname: nickname }));
  }, []);

  const updateGiphyApiKey = useCallback((key: string) => {
    setSettings((prev) => ({ ...prev, giphyApiKey: key.trim() }));
  }, []);

  const updateReduceMotion = useCallback((reduce: boolean) => {
    setSettings((prev) => ({ ...prev, reduceMotion: reduce }));
  }, []);

  const updateCheckForUpdates = useCallback((check: boolean) => {
    setSettings((prev) => ({ ...prev, checkForUpdates: check }));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(settings.reduceMotion);
  }, [settings.reduceMotion]);

  const randomizeNickname = useCallback(() => {
    const randomName = getRandomGhostName();
    setSettings((prev) => ({ ...prev, defaultNickname: randomName }));
  }, []);

  const resetSettings = useCallback(() => {
    const defaultSettings = loadSettings(getRandomGhostName);
    localStorage.removeItem("ghostly_app_settings");
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
        updateGiphyApiKey,
        updateReduceMotion,
        updateCheckForUpdates,
        randomizeNickname,
        resetSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
