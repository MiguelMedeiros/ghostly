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

/** Where a section's options are on the screen, for the index's mark (top and bottom, in the window's pixels). */
export interface SectionBox { section: SettingsSection; top: number; bottom: number }

/**
 * The section a wide screen's index marks: the one picked in the index or named by the address (`wanted`) while it is
 * in view, since the page cannot scroll the last sections up to its top, and the page may still grow around it as
 * its options load. Otherwise the last one whose top has reached `line`, just under the page's top, and at the page's
 * end (`atEnd`) the last section.
 */
export function sectionInView(boxes: readonly SectionBox[], line: number, viewBottom: number, atEnd: boolean, wanted: SettingsSection | null): SettingsSection {
  const target = wanted ? boxes.find((box) => box.section === wanted) : undefined;
  if (target && target.top < viewBottom && target.bottom > line) return target.section;
  if (atEnd && boxes.length) return boxes[boxes.length - 1].section;
  let current: SettingsSection | null = null;
  for (const box of boxes) if (box.top <= line) current = box.section;
  return current ?? SETTINGS_SECTIONS[0];
}

/** What a setting needs to be there at all: several profiles, an updater, wake-up push, calls' devices. */
export type SettingNeeds = "profiles" | "updates" | "wake" | "media";

/** One option the menu's search finds, by its row's label or by other words people look for it by. */
export interface SettingEntry {
  section: SettingsSection;
  label: TranslationKey;
  /** Other words for it, in the language shown ("dark, light, theme" for Mode): found, never shown. */
  words?: TranslationKey;
  needs?: SettingNeeds;
}

/** Every option's label, in the order of its section's page. */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  { section: "profile", label: "profileSwitcher.title", words: "settings.searchWords.account", needs: "profiles" },
  { section: "profile", label: "settings.profilePeek", needs: "profiles" },
  { section: "profile", label: "settings.defaultNickname", words: "settings.searchWords.nickname" },
  { section: "appearance", label: "settings.colorTheme", words: "settings.searchWords.colour" },
  { section: "appearance", label: "settings.colorScheme", words: "settings.searchWords.mode" },
  { section: "appearance", label: "settings.chatListDensity", words: "settings.searchWords.chatList" },
  { section: "appearance", label: "settings.language", words: "settings.searchWords.language" },
  { section: "appearance", label: "settings.reduceMotion", words: "settings.searchWords.motion" },
  { section: "notifications", label: "settings.notificationSounds", words: "settings.searchWords.sounds" },
  { section: "notifications", label: "settings.cues.payments", words: "settings.cues.paymentsHint" },
  { section: "notifications", label: "settings.cues.identities", words: "settings.cues.identitiesHint" },
  { section: "notifications", label: "settings.cues.connection", words: "settings.cues.connectionHint" },
  { section: "notifications", label: "settings.cues.chat", words: "settings.cues.chatHint" },
  { section: "notifications", label: "settings.cues.interface", words: "settings.cues.interfaceHint" },
  { section: "notifications", label: "settings.systemNotifications", words: "settings.searchWords.systemNotices" },
  { section: "notifications", label: "pwa.wake", words: "settings.searchWords.wake", needs: "wake" },
  { section: "media", label: "settings.media.microphone", words: "settings.searchWords.microphone", needs: "media" },
  { section: "media", label: "settings.media.camera", words: "settings.searchWords.camera", needs: "media" },
  { section: "media", label: "settings.media.speaker", words: "settings.searchWords.speaker", needs: "media" },
  { section: "privacy", label: "settings.linkPreviews", words: "settings.searchWords.linkPreviews" },
  { section: "privacy", label: "settings.sendTyping" },
  { section: "privacy", label: "settings.publicProfiles", words: "settings.searchWords.publicProfiles" },
  { section: "privacy", label: "settings.lockScreen", words: "settings.searchWords.lock" },
  { section: "privacy", label: "settings.password" },
  { section: "network", label: "network.relays", words: "settings.searchWords.relays" },
  { section: "network", label: "network.iroh" },
  { section: "network", label: "network.hyperdht" },
  { section: "network", label: "network.pushRelay" },
  { section: "network", label: "network.turn", words: "settings.searchWords.turn" },
  { section: "network", label: "network.domainLookups", words: "settings.searchWords.domains" },
  { section: "storage", label: "settings.storageUsed", words: "settings.searchWords.storage" },
  { section: "storage", label: "sidebar.deleteAllChats", words: "settings.searchWords.deleteChats" },
  { section: "storage", label: "settings.clearAllData", words: "settings.searchWords.clearData" },
  { section: "about", label: "updates.auto", words: "settings.searchWords.updates", needs: "updates" },
  { section: "about", label: "settings.version", words: "settings.searchWords.version" },
  { section: "about", label: "settings.license" },
];

/** Lower case, without accents: "Língua" is found by "lingua". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The options whose label, other words or section's name hold `query`, in the language shown. Options this device
 * does not have (`has` says no) are left out.
 */
export function searchSettings(query: string, t: (key: TranslationKey) => string, has: (needs: SettingNeeds) => boolean): SettingEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS_INDEX.filter((entry) => {
    if (entry.needs && !has(entry.needs)) return false;
    const text = fold(`${t(entry.label)} ${entry.words ? t(entry.words) : ""} ${t(SECTION_TITLE[entry.section])}`);
    return words.every((word) => text.includes(word));
  });
}
