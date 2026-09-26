import { clearChatData } from "@ghostly/browser/shared/idb";
import { removeFileBytes } from "@ghostly/browser/shared/fileBytes";
import { LEGACY_JOIN_PREFIX, getStorageProfile, ownsKey } from "./storage";
import { registryKey } from "./profiles";

export type ColorScheme = "dark" | "light" | "system";
export type ColorTheme = "classic" | "monochrome" | "cyan" | "purple";
/** How tall the chat list's rows are: `compact` (name and last message) or `comfortable` (and the contact's key). */
export type ChatListDensity = "compact" | "comfortable";
export type Language = "en" | "pt" | "es" | "fr" | "it" | "zh" | "ja" | "ar";

// Legacy support
export type Theme = ColorScheme;

export interface LockScreenSettings {
  enabled: boolean;
  passwordHash: string | null;
  timeoutMinutes: number;
}

/** The kinds of finer sounds (src/lib/cues.ts), each turned on or off on its own, under the Sounds switch. */
export const CUE_CATEGORIES = ["payments", "identities", "connection", "chat", "interface"] as const;
export type CueCategory = (typeof CUE_CATEGORIES)[number];
export type CueSwitches = Record<CueCategory, boolean>;
/** Interface sounds (cards, a new wallet or group) are for those who ask for them: off until turned on. */
export const DEFAULT_CUES: Readonly<CueSwitches> = { payments: true, identities: true, connection: true, chat: true, interface: false };

export interface NotificationSettings {
  soundEnabled: boolean;
  systemEnabled: boolean;
  /** Which categories of finer sounds play. Absent (settings from before them): `DEFAULT_CUES`. */
  cues?: Partial<CueSwitches>;
}

export interface AppSettings {
  theme: Theme; // Legacy: now used as colorScheme
  colorScheme: ColorScheme;
  colorTheme: ColorTheme;
  language: Language;
  lockScreen: LockScreenSettings;
  notifications: NotificationSettings;
  defaultNickname: string;
  /** Turns animations off, on top of the system's own preference. */
  reduceMotion: boolean;
  chatListDensity: ChatListDensity;
  /**
   * Whether this client may ask, now and then, whether a newer version was
   * published. The question is a request that says this device runs Ghostly,
   * so it is the user's to allow; off, updates are only looked for on demand.
   */
  checkForUpdates: boolean;
  /**
   * Link previews (WISP 401 § Link previews): when a message has a link, this app reads the page's title and picture
   * and sends them with it. Only the sender's app ever contacts the site; off, links go as plain text.
   */
  linkPreviews: boolean;
  /** WISP 1000: this profile's random storage space, chosen on first backup. */
  backupSpace?: string;
  /** WISP 1002: where backups go, if S3-compatible storage is set up. Never copied into a backup. */
  backupS3?: import("@ghostly/browser/backup/s3").S3Config | null;
}

/** Each local profile keeps its own settings (WISP 04); the default profile keeps the original key. */
const settingsKey = () => (getStorageProfile() ? `ghostly_${getStorageProfile()}_app_settings` : "ghostly_app_settings");

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
    systemEnabled: false,
    cues: { ...DEFAULT_CUES },
  },
  defaultNickname: "",
  reduceMotion: false,
  chatListDensity: "compact",
  checkForUpdates: true,
  linkPreviews: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(settingsKey());
    if (!raw) {
      const initialSettings = { ...DEFAULT_SETTINGS };
      localStorage.setItem(settingsKey(), JSON.stringify(initialSettings));
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
        cues: { ...DEFAULT_CUES, ...parsed.notifications?.cues },
      },
      defaultNickname: parsed.defaultNickname ?? DEFAULT_SETTINGS.defaultNickname,
      chatListDensity: parsed.chatListDensity === "comfortable" ? "comfortable" : "compact",
      linkPreviews: parsed.linkPreviews !== false,
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

/**
 * Everything this profile keeps on the device except the wallet: its
 * localStorage keys and the chats, files and services in its peer's database.
 * Other profiles and the list of profiles stay. The peer forgets the links on
 * its next reconcile; the caller reloads.
 */
export async function clearAllData(): Promise<void> {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === registryKey()) continue;
    // The join flags of older versions are not in the namespace, and each one
    // carries the session id of a chat that existed; they are the default profile's.
    if (ownsKey(key) || (!getStorageProfile() && key.startsWith(LEGACY_JOIN_PREFIX))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
  await clearChatData();
  await removeFileBytes().catch(() => {});
}

export const APP_WEBSITE = "https://github.com/MiguelMedeiros/ghostly";
/** Where every client sends someone who installs a new version by hand. */
export const RELEASES_URL = `${APP_WEBSITE}/releases/latest`;
export const APP_LICENSE = "MIT";

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(settingsKey(), JSON.stringify(settings));
    window.dispatchEvent(new Event("settings-updated"));
  } catch {
    // Storage full or unavailable
  }
}

/** OWASP's 2023 figure for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERATIONS = 600_000;
/** Hashes stored as `salt:hash` before the iteration count was part of the format. */
const LEGACY_PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

/** Compares every byte, so how long it takes says nothing about where they differ. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

const SCHEME = "pbkdf2-sha256";

/** `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return [SCHEME, PBKDF2_ITERATIONS, toHex(salt), toHex(hash)].join("$");
}

/** Whether a stored hash predates the current format and should be replaced once the password is known. */
export function needsRehash(storedHash: string): boolean {
  const [scheme, iterations] = storedHash.split("$");
  return scheme !== SCHEME || Number(iterations) < PBKDF2_ITERATIONS;
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  let salt: Uint8Array<ArrayBuffer> | null;
  let expected: Uint8Array | null;
  let iterations: number;

  if (storedHash.startsWith(`${SCHEME}$`)) {
    const [, count, saltHex, hashHex] = storedHash.split("$");
    iterations = Number(count);
    salt = fromHex(saltHex ?? "");
    expected = fromHex(hashHex ?? "");
    if (!Number.isInteger(iterations) || iterations < 1) return false;
  } else if (storedHash.includes(":")) {
    // `salt:hash` at 100k iterations.
    const [saltHex, hashHex] = storedHash.split(":");
    iterations = LEGACY_PBKDF2_ITERATIONS;
    salt = fromHex(saltHex ?? "");
    expected = fromHex(hashHex ?? "");
  } else {
    // The oldest format: unsalted SHA-256.
    expected = fromHex(storedHash);
    if (!expected) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    return constantTimeEqual(new Uint8Array(digest), expected);
  }

  if (!salt || !expected || salt.length === 0 || expected.length === 0) return false;
  return constantTimeEqual(await pbkdf2(password, salt, iterations), expected);
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
