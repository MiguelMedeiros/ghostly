import type { TranslationKey } from "../contexts/I18nContext";

/**
 * Settings' sections. On a phone `/settings` is a menu of them and each one is a screen of its own
 * (`/settings/<id>`), with Back to the menu; on a wider screen they are one page with an index beside it.
 */
export const SETTINGS_SECTIONS = ["profile", "appearance", "notifications", "media", "privacy", "network", "storage", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Each section's name: the title of its screen and its line in the menu and the index. */
export const SECTION_TITLE: Record<SettingsSection, TranslationKey> = {
  profile: "settings.profile",
  appearance: "settings.appearance",
  notifications: "settings.notifications",
  media: "settings.media.title",
  privacy: "settings.security",
  network: "network.title",
  storage: "settings.data",
  about: "settings.about",
};

/** Addresses from before the sections, and where they lead now. */
const OLD_SECTIONS: Record<string, SettingsSection> = { advanced: "network" };

export const settingsPath = (section: SettingsSection) => `/settings/${section}`;

/** The section an address names, an old one's new place included; null for the menu or an unknown name. */
export function settingsSection(name: string | undefined): SettingsSection | null {
  if (!name) return null;
  if ((SETTINGS_SECTIONS as readonly string[]).includes(name)) return name as SettingsSection;
  return OLD_SECTIONS[name] ?? null;
}

/** Whether `name` is an old section's address (it is replaced by the new one's). */
export const isOldSection = (name: string | undefined) => !!name && name in OLD_SECTIONS;

/** What a setting needs to be there at all: several profiles, an updater, wake-up push, calls' devices. */
export type SettingNeeds = "profiles" | "updates" | "wake" | "media";

/** One option the menu's search finds, by its row's label. */
export interface SettingEntry {
  section: SettingsSection;
  label: TranslationKey;
  needs?: SettingNeeds;
}

/** Every option's label, in the order of its section's page. */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  { section: "profile", label: "profileSwitcher.title", needs: "profiles" },
  { section: "profile", label: "settings.profilePeek", needs: "profiles" },
  { section: "profile", label: "settings.defaultNickname" },
  { section: "appearance", label: "settings.colorTheme" },
  { section: "appearance", label: "settings.colorScheme" },
  { section: "appearance", label: "settings.chatListDensity" },
  { section: "appearance", label: "settings.language" },
  { section: "appearance", label: "settings.reduceMotion" },
  { section: "notifications", label: "settings.notificationSounds" },
  { section: "notifications", label: "settings.cues.payments" },
  { section: "notifications", label: "settings.cues.identities" },
  { section: "notifications", label: "settings.cues.connection" },
  { section: "notifications", label: "settings.cues.chat" },
  { section: "notifications", label: "settings.cues.interface" },
  { section: "notifications", label: "settings.systemNotifications" },
  { section: "notifications", label: "pwa.wake", needs: "wake" },
  { section: "media", label: "settings.media.microphone", needs: "media" },
  { section: "media", label: "settings.media.camera", needs: "media" },
  { section: "media", label: "settings.media.speaker", needs: "media" },
  { section: "privacy", label: "settings.linkPreviews" },
  { section: "privacy", label: "settings.sendTyping" },
  { section: "privacy", label: "settings.publicProfiles" },
  { section: "privacy", label: "settings.lockScreen" },
  { section: "privacy", label: "settings.password" },
  { section: "network", label: "network.relays" },
  { section: "network", label: "network.iroh" },
  { section: "network", label: "network.hyperdht" },
  { section: "network", label: "network.pushRelay" },
  { section: "network", label: "network.turn" },
  { section: "network", label: "network.domainLookups" },
  { section: "storage", label: "settings.storageUsed" },
  { section: "storage", label: "sidebar.deleteAllChats" },
  { section: "storage", label: "settings.clearAllData" },
  { section: "about", label: "updates.auto", needs: "updates" },
  { section: "about", label: "settings.version" },
  { section: "about", label: "settings.license" },
];

/** Lower case, without accents: "Língua" is found by "lingua". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The options whose label (or whose section's name) holds `query`, in the language shown. Options this device
 * does not have (`has` says no) are left out.
 */
export function searchSettings(query: string, t: (key: TranslationKey) => string, has: (needs: SettingNeeds) => boolean): SettingEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS_INDEX.filter((entry) => {
    if (entry.needs && !has(entry.needs)) return false;
    const text = fold(`${t(entry.label)} ${t(SECTION_TITLE[entry.section])}`);
    return words.every((word) => text.includes(word));
  });
}
