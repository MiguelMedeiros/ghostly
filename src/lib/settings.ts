export type ColorScheme = "dark" | "light" | "system";
export type ColorTheme = "classic" | "monochrome" | "cyan" | "purple";
export type Language = "en" | "pt" | "es" | "fr" | "it" | "zh" | "ja" | "ar";

// Legacy support
export type Theme = ColorScheme;

export interface LockScreenSettings {
  enabled: boolean;
  passwordHash: string | null;
  timeoutMinutes: number;
}

export interface NotificationSettings {
  soundEnabled: boolean;
}

export interface AppSettings {
  theme: Theme; // Legacy: now used as colorScheme
  colorScheme: ColorScheme;
  colorTheme: ColorTheme;
  language: Language;
  lockScreen: LockScreenSettings;
  notifications: NotificationSettings;
  defaultNickname: string;
}

const SETTINGS_KEY = "ghostly_app_settings";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark", // Legacy
  colorScheme: "dark",
  colorTheme: "cyan",
  language: "en",
  lockScreen: {
    enabled: false,
    passwordHash: null,
    timeoutMinutes: 5,
  },
  notifications: {
    soundEnabled: true,
  },
  defaultNickname: "",
};

export function loadSettings(getRandomName?: () => string): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      const randomNickname = getRandomName ? getRandomName() : "";
      const initialSettings = { ...DEFAULT_SETTINGS, defaultNickname: randomNickname };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(initialSettings));
      return initialSettings;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    
    // Migration: if colorScheme doesn't exist, use theme value
    const colorScheme = parsed.colorScheme ?? parsed.theme ?? DEFAULT_SETTINGS.colorScheme;
    
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      colorScheme,
      colorTheme: parsed.colorTheme ?? DEFAULT_SETTINGS.colorTheme,
      theme: colorScheme, // Keep in sync for legacy
      lockScreen: {
        ...DEFAULT_SETTINGS.lockScreen,
        ...parsed.lockScreen,
      },
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        ...parsed.notifications,
      },
      defaultNickname: parsed.defaultNickname ?? DEFAULT_SETTINGS.defaultNickname,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function getStorageUsage(): { used: number; keys: number } {
  let totalSize = 0;
  let keyCount = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("ghostly")) {
      const value = localStorage.getItem(key) || "";
      totalSize += key.length + value.length;
      keyCount++;
    }
  }
  return { used: totalSize * 2, keys: keyCount };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function clearAllData(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("ghostly")) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}

export const APP_VERSION = "0.0.1";
export const APP_WEBSITE = "https://github.com/nicbus/ghostly";
export const APP_LICENSE = "MIT";

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable
  }
}

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return passwordHash === hash;
}

export const TIMEOUT_OPTIONS = [
  { value: 1, label: "1 minute" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
] as const;

export const LANGUAGE_OPTIONS: { value: Language; label: string; native: string }[] = [
  { value: "en", label: "English", native: "English" },
  { value: "pt", label: "Portuguese", native: "Português" },
  { value: "es", label: "Spanish", native: "Español" },
  { value: "fr", label: "French", native: "Français" },
  { value: "it", label: "Italian", native: "Italiano" },
  { value: "zh", label: "Chinese", native: "中文" },
  { value: "ja", label: "Japanese", native: "日本語" },
  { value: "ar", label: "Arabic", native: "العربية" },
];

export const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

export const COLOR_SCHEME_OPTIONS: { value: ColorScheme; labelKey: string }[] = [
  { value: "light", labelKey: "settings.colorSchemes.light" },
  { value: "dark", labelKey: "settings.colorSchemes.dark" },
  { value: "system", labelKey: "settings.colorSchemes.system" },
];

export const COLOR_THEME_OPTIONS: { value: ColorTheme; labelKey: string; description: string }[] = [
  { value: "classic", labelKey: "settings.colorThemes.classic", description: "Green accent" },
  { value: "monochrome", labelKey: "settings.colorThemes.monochrome", description: "Black & white" },
  { value: "cyan", labelKey: "settings.colorThemes.cyan", description: "Ice blue" },
  { value: "purple", labelKey: "settings.colorThemes.purple", description: "Lavender mist" },
];
