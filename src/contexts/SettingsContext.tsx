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
