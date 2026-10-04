import { knownDeviceGate } from "@ghostly/browser/devices/gate";
import type { ColorTheme } from "./settings";

/**
 * Local profiles (WISP 04): separate containers on one device, one active at a time. Each profile has its
 * own chats, peer database (links, files, wallets, payment journal, services), settings and single-peer
 * lock. Nothing about profiles is ever sent to a contact. The registry below is the only shared record.
 */
export interface ProfileEntry {
  /** Empty for the default profile, whose data lives in the original, unprefixed namespace. */
  id: string;
  name: string;
  createdAt: number;
  /** Brought back from a backup (WISP 05), until the mark is taken off: shown with the app's word for it after the name. */
  restored?: true;
  /**
   * The storage namespace the profile lives in, where it is not the one its id names: a handoff installs the state it
   * took under a new namespace and points the profile at it, in one write of this registry (WISP 06 § Installing the
   * staged state). Everything that names the profile's storage goes through `namespaceOf`.
   */
  space?: string;
}
interface Registry { version: 1; active: string; profiles: ProfileEntry[] }

/** Desktop's GHOSTLY_PROFILE: the process's own space, with its own profiles inside (for side-by-side testing). */
let base = "";
export function setProfileBase(name: string): void { base = name; }
/** The registry of this space. */
export const registryKey = () => (base ? `ghostly_${base}_profiles` : "ghostly_profiles");
/** The namespace an id names, before any pointer. */
const derivedNamespace = (id: string) => (id ? (base ? `${base}-${id}` : id) : base);
/** A storage namespace a handoff made: what may follow `ghostly_` in a database name or a key prefix. */
const SPACE = /^[A-Za-z0-9_.-]{1,100}$/;
let pointers: { raw: string | null; spaces: Map<string, string> } = { raw: null, spaces: new Map() };
/** The registry's pointers (`ProfileEntry.space`), read again only when the registry changed. */
function pointerOf(id: string): string | undefined {
  let raw: string | null;
  try { raw = localStorage.getItem(registryKey()); } catch { return undefined; }
  if (raw !== pointers.raw) {
    const spaces = new Map<string, string>();
    try {
      const parsed = JSON.parse(raw ?? "null") as Partial<Registry> | null;
      for (const p of Array.isArray(parsed?.profiles) ? parsed!.profiles : []) if (p && typeof p.id === "string" && typeof p.space === "string" && SPACE.test(p.space)) spaces.set(p.id, p.space);
    } catch { /* no pointers */ }
    pointers = { raw, spaces };
  }
  return pointers.spaces.get(id);
}
/** The storage namespace of a profile: its prefix `ghostly_<ns>_`, database `ghostly_<ns>`, lock `ghostly-peer-<ns>`. */
export const namespaceOf = (id: string) => pointerOf(id) ?? derivedNamespace(id);
const ID = /^[a-z0-9]{10}$/;
export const PROFILE_THEMES: ColorTheme[] = ["cyan", "purple", "classic", "monochrome"];
/** The swatch each theme shows in the switcher and on the profile's avatar. */
export const THEME_COLOR: Record<ColorTheme, string> = { cyan: "#22d3ee", purple: "#a78bfa", classic: "#00a884", monochrome: "#d4d4d8" };
const DEFAULT_ENTRY: ProfileEntry = { id: "", name: "Personal", createdAt: 0 };
/**
 * The first profile's name until someone renames it, in the app's language: the registry keeps the built-in English
 * one, so a change of language changes it too. A backup of it carries the built-in one and says that it is
 * (`profile.builtIn`), so the copy restored from it follows the language as well.
 */
let defaultName = DEFAULT_ENTRY.name;
export function setDefaultProfileName(name: string): void {
  defaultName = cleanName(name) || DEFAULT_ENTRY.name;
}
/** A restored profile's name as shown, "Work (restored)" in the app's language: the registry keeps only "Work". */
let restoredName = (name: string) => `${name} (restored)`;
export function setRestoredProfileName(format: (name: string) => string): void {
  restoredName = format;
}
/**
 * A profile as it is shown: one with the built-in name (the first one never renamed, or a copy of it restored from a
 * backup) by the name of the app's language; a restored one with the app's word for restored.
 */
const shown = (entry: ProfileEntry): ProfileEntry => {
  const name = entry.name === DEFAULT_ENTRY.name ? defaultName : entry.name;
  return entry.restored ? { ...entry, name: restoredName(name) } : name === entry.name ? entry : { ...entry, name };
};
/**
 * The word each language puts after a restored profile's name (`profile.restoredName` in every locale, which a test
 * checks against this list). The registry never keeps it in a name: an older app wrote the English one there, and a
 * name typed or pasted from the field of another language could carry any of them.
 */
export const RESTORED_WORDS = ["restored", "restaurado", "restauré", "ripristinato", "مستعاد", "已恢复", "復元"];
/**
 * The first profile's name in each language (`profile.defaultName` in every locale, which a test checks against this
 * list). A backup an older app made of that profile, never renamed, carries the one of that app's language instead
 * of the built-in one.
 */
export const DEFAULT_NAMES: Readonly<Record<string, string>> = { en: "Personal", pt: "Pessoal", es: "Personal", fr: "Personnel", it: "Personale", ar: "شخصي", zh: "个人", ja: "個人" };
const RESTORED_SUFFIX = new RegExp(`^(.*\\S)\\s*[(（]\\s*(?:${RESTORED_WORDS.join("|")})\\s*[)）]$`, "iu");
/** A name without the restored words at its end ("Work (restaurado) (restored)" is "Work"), and whether it had any. */
function withoutRestoredWord(name: string): { name: string; marked: boolean } {
  let rest = name, match: RegExpExecArray | null;
  while ((match = RESTORED_SUFFIX.exec(rest))) rest = match[1].trimEnd();
  return { name: rest, marked: rest !== name };
}
/** A cleaned name for profile `id`, the word for restored taken out of it, and whether that marks it restored. */
function nameAndMark(id: string, raw: string): { name: string; marked: boolean } {
  // The first profile is never a restored one: its name is left as it is. The word comes off before the name is cut to
  // its 32 characters, which could cut the word in half.
  if (!id) return { name: cleanName(raw), marked: false };
  const collapsed = raw.replace(/\s+/g, " ").trim();
  // Composed first, so "restauré" typed as e + accent is the word too.
  const { name, marked } = withoutRestoredWord(collapsed.normalize("NFC"));
  return { name: cleanName(marked ? name : collapsed), marked };
}

/**
 * Whether the name in a backup with no `profile.builtIn` (made before the marker) is the built-in one. Those apps
 * wrote the first profile never renamed as the name in the app's language, so it is only when the name is the first
 * profile's name in the language the backup itself was made in (its settings; English when they name none). The same
 * word of another language ("Pessoal" in a backup of an English app) was typed by someone, and is kept as typed.
 */
export function builtInNameBefore(name: string, language: string | undefined): boolean {
  const { name: clean } = nameAndMark("restored", name);
  return clean === DEFAULT_ENTRY.name || clean === (DEFAULT_NAMES[language ?? "en"] ?? DEFAULT_ENTRY.name);
}

function read(): Registry {
  try {
    const raw = JSON.parse(localStorage.getItem(registryKey()) ?? "null") as Partial<Registry> | null;
    const profiles = (Array.isArray(raw?.profiles) ? raw!.profiles : [])
      .filter((p): p is ProfileEntry => !!p && typeof p.id === "string" && (p.id === "" || ID.test(p.id)) && typeof p.name === "string")
      .map((p) => {
        const { name, marked } = nameAndMark(p.id, p.name);
        const entry: ProfileEntry = { id: p.id, name: name || (p.id ? "Profile" : DEFAULT_ENTRY.name), createdAt: Number(p.createdAt) || 0 };
        if (p.restored === true || marked) entry.restored = true;
        if (typeof p.space === "string" && SPACE.test(p.space)) entry.space = p.space;
        return entry;
      });
    if (!profiles.some((p) => p.id === "")) profiles.unshift({ ...DEFAULT_ENTRY });
    const active = typeof raw?.active === "string" && profiles.some((p) => p.id === raw.active) ? raw.active : "";
    return { version: 1, active, profiles };
  } catch {
    return { version: 1, active: "", profiles: [{ ...DEFAULT_ENTRY }] };
  }
}
function write(registry: Registry, notify = true): void {
  localStorage.setItem(registryKey(), JSON.stringify(registry));
  if (notify) window.dispatchEvent(new Event("profiles-updated"));
}
const cleanName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 32);

export function listProfiles(): ProfileEntry[] { return read().profiles.map(shown); }

/** A profile's name as shown, without the word the app adds to a restored one: what the Profile page's field holds. */
export function baseProfileName(id: string): string | undefined {
  const entry = read().profiles.find((p) => p.id === id);
  return entry && shown({ id: entry.id, name: entry.name, createdAt: entry.createdAt }).name;
}

/**
 * A profile's name as the registry keeps it: what a backup of it carries. For the first profile never renamed that is
 * the built-in name, never the app's language's, so the copy restored from it follows the language too.
 */
export function storedProfileName(id: string): string | undefined {
  return read().profiles.find((p) => p.id === id)?.name;
}

/** Whether a name the registry keeps is the built-in one, which is shown in the app's language: what a backup marks. */
export const isBuiltInName = (name: string) => name === DEFAULT_ENTRY.name;

/**
 * The profile this page runs as, fixed when it starts (see the entry points). The registry's choice can change under
 * a running page: a tab that waited for another to close takes over as the profile it opened with, while the other
 * tab may have switched the choice to another profile meanwhile. Until a page starts, it is the registry's.
 */
let running: string | undefined;
export function setRunningProfile(id: string | undefined): void { running = id; }
/** The profile last chosen in this space: the one the next page starts as. */
export function chosenProfileId(): string { return read().active; }
/** The profile this page runs as; before it starts, the one to start as (the one last chosen in this space). */
export function activeProfileId(): string { return running ?? chosenProfileId(); }
export function currentProfile(): ProfileEntry {
  const id = activeProfileId();
  return shown(read().profiles.find((p) => p.id === id) ?? { id, name: id || DEFAULT_ENTRY.name, createdAt: 0 });
}

export const settingsKeyFor = (id: string) => (namespaceOf(id) ? `ghostly_${namespaceOf(id)}_app_settings` : "ghostly_app_settings");
/** A profile's color theme, read from its own settings: the switcher shows each one in its colors. */
export function themeOf(id: string): ColorTheme {
  try {
    const theme = (JSON.parse(localStorage.getItem(settingsKeyFor(id)) ?? "{}") as { colorTheme?: ColorTheme }).colorTheme;
    return theme && PROFILE_THEMES.includes(theme) ? theme : "cyan";
  } catch { return "cyan"; }
}

/**
 * A new, empty profile with its own name and a theme no other profile uses yet, so switching is visible at
 * once. It inherits language and light/dark mode from the current profile; nothing else is copied.
 */
export function createProfile(name: string): ProfileEntry {
  const id = newProfileId();
  const { name: clean, marked } = nameAndMark(id, name);
  if (!clean) throw new Error("Give the profile a name");
  const registry = read();
  const used = registry.profiles.map((p) => themeOf(p.id));
  const theme = PROFILE_THEMES.find((t) => !used.includes(t)) ?? PROFILE_THEMES[registry.profiles.length % PROFILE_THEMES.length];
  let inherited: Record<string, unknown> = {};
  try {
    const current = JSON.parse(localStorage.getItem(settingsKeyFor(activeProfileId())) ?? "{}") as Record<string, unknown>;
    // The lock goes with it: a new profile must not be a way around the lock of the one it came from.
    inherited = { language: current.language, colorScheme: current.colorScheme, theme: current.colorScheme, lockScreen: current.lockScreen };
  } catch { /* defaults */ }
  localStorage.setItem(settingsKeyFor(id), JSON.stringify({ ...inherited, colorTheme: theme }));
  const entry: ProfileEntry = { id, name: clean, createdAt: Date.now() };
  if (marked) entry.restored = true;
  write({ ...registry, profiles: [...registry.profiles, entry] });
  return shown(entry);
}

/** A fresh id no profile of this space uses yet. */
export function newProfileId(): string {
  const taken = new Set(read().profiles.map((p) => p.id));
  const draw = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  let id = draw();
  while (taken.has(id)) id = draw();
  return id;
}

/**
 * Adds a profile whose data is already in place (a restored backup, WISP 05), and returns it as it is shown.
 * `builtIn`: the backup says its name is the built-in one, so the profile takes it and follows the app's language.
 * Any other name is kept as it was written, a word that is the first profile's name in some language included.
 */
export function registerProfile(id: string, name: string, restored = false, builtIn = false): ProfileEntry {
  if (!ID.test(id)) throw new Error("Invalid profile id");
  const registry = read();
  if (registry.profiles.some((p) => p.id === id)) throw new Error("That profile already exists");
  // A backup of a profile an older app restored carries "(restored)", or the word of another language, in its name:
  // the flag says it now.
  const { name: clean, marked } = nameAndMark(id, name);
  const entry: ProfileEntry = { id, name: builtIn ? DEFAULT_ENTRY.name : clean || "Restored", createdAt: Date.now() };
  if (restored || marked) entry.restored = true;
  write({ ...registry, profiles: [...registry.profiles, entry] });
  return shown(entry);
}

/** Takes a profile off the list. Its data must already be gone (see profileData). */
export function unregisterProfile(id: string): void {
  if (!id) throw new Error("The first profile cannot be removed");
  const registry = read();
  if (registry.active === id) throw new Error("Switch to another profile first");
  write({ ...registry, profiles: registry.profiles.filter((p) => p.id !== id) });
}

/**
 * Gives a profile a new name. A restored one stays marked restored (the Profile page's tag takes the mark off): the
 * field edits the name only, and the word for restored typed or pasted into it is the mark, never part of the name.
 */
export function renameProfile(id: string, name: string): void {
  const { name: clean, marked } = nameAndMark(id, name);
  if (!clean) throw new Error("Give the profile a name");
  const registry = read();
  write({ ...registry, profiles: registry.profiles.map((p) => (p.id === id ? { ...p, name: clean, ...(marked ? { restored: true as const } : {}) } : p)) });
}

/** Takes the restored mark off a profile: from now on it is shown by its name alone. */
export function clearRestoredMark(id: string): void {
  const registry = read();
  write({ ...registry, profiles: registry.profiles.map((p) => (p.id === id ? { id: p.id, name: p.name, createdAt: p.createdAt, ...(p.space ? { space: p.space } : {}) } : p)) });
}

/** The database name of a namespace. */
export const databaseOfSpace = (ns: string) => (ns ? `ghostly_${ns}` : "ghostly");

/** The profile whose storage is this peer database, or undefined. */
export function profileOfDatabase(database: string): ProfileEntry | undefined {
  return read().profiles.find((p) => databaseOfSpace(namespaceOf(p.id)) === database);
}

/** A namespace no profile of this space uses or names: a staging namespace for a handoff. */
export function newSpace(): string {
  const registry = read();
  const taken = new Set(registry.profiles.flatMap((p) => [derivedNamespace(p.id), namespaceOf(p.id)]));
  for (;;) {
    const id = newProfileId();
    const ns = derivedNamespace(id);
    if (!taken.has(ns)) return ns;
  }
}

/**
 * Points the profile whose storage is `from` at the namespace of `to`: one write of the registry, the "one pointer"
 * of WISP 06 § Installing the staged state. The registry's choice moves with it.
 */
export function pointProfile(from: string, to: string): void {
  const entry = profileOfDatabase(from);
  if (!entry) throw new Error("No profile uses that storage");
  const target = to === "ghostly" ? "" : to.replace(/^ghostly_/, "");
  if (to !== "ghostly" && !to.startsWith("ghostly_")) throw new Error("Not a profile's storage");
  if (target && !SPACE.test(target)) throw new Error("Not a profile's storage");
  const registry = read();
  const space = target === derivedNamespace(entry.id) ? undefined : target;
  write({ ...registry, profiles: registry.profiles.map((p) => {
    if (p.id !== entry.id) return p;
    const { space: _was, ...rest } = p;
    return space === undefined ? rest : { ...rest, space };
  }) });
  // Read back before anyone reloads on it: a write the storage did not keep fails here, not as an empty profile later.
  if (namespaceOf(entry.id) !== (space ?? derivedNamespace(entry.id))) throw new Error("The profile's storage could not be pointed at the new state");
}

/**
 * The profile's own database name, before any pointer: what a handoff's staged copy names as the profile it holds
 * (`DeviceRecord.home`).
 */
export const homeDatabaseOf = (id: string) => databaseOfSpace(derivedNamespace(id));

/**
 * A profile whose pointer is gone (WISP 06 § Installing the staged state): no `space` in the registry, no device record
 * under its own database, and a device record of a namespace a handoff installed for it (`home`). The pointer is
 * written again, to that namespace, before anything opens the old, empty one. Returns whether it was. `records`: the
 * device records on this device (`listDeviceRecords`).
 */
export function recoverProfilePointer(id: string, records: readonly { profile: string; home?: string; state: string; saved: number }[]): boolean {
  // A profile the registry does not list is not known here: nothing is guessed for it.
  if (pointerOf(id) !== undefined || !read().profiles.some((p) => p.id === id)) return false;
  const home = homeDatabaseOf(id);
  if (records.some((record) => record.profile === home)) return false;
  const named = new Set(read().profiles.map((p) => databaseOfSpace(namespaceOf(p.id))));
  const found = records
    .filter((record) => record.home === home && record.profile !== home && record.profile.startsWith("ghostly_") && !named.has(record.profile) && SPACE.test(record.profile.slice("ghostly_".length)))
    .sort((a, b) => Number(b.state === "active") - Number(a.state === "active") || b.saved - a.saved)[0];
  if (!found) return false;
  pointProfile(home, found.profile);
  return true;
}

/** Where a profile's own keys start in localStorage: `ghostly_<ns>_`, or `ghostly_` for the default one. */
export const prefixOf = (id: string) => (namespaceOf(id) ? `ghostly_${namespaceOf(id)}_` : "ghostly_");

/**
 * The places a profile can be left on and come back to. A chat or a group by its id, never an address that
 * carries keys (an invite, a group link), which must not be written down.
 */
const RETURNABLE = /^\/(?:wallet|services|profile|identities|settings|chat\/[^/]+|group\/[^/]+)?$/;
const lastRouteKey = (id: string) => `${prefixOf(id)}last_route`;
/** Where this profile was when it was last left: switching back to it opens there. */
export function lastRouteOf(id: string): string {
  try {
    const route = localStorage.getItem(lastRouteKey(id)) ?? "";
    return RETURNABLE.test(route) ? route : "/";
  } catch { return "/"; }
}
function rememberRoute(id: string): void {
  const route = window.location.hash.replace(/^#/, "").split("?")[0] || "/";
  try {
    if (RETURNABLE.test(route)) localStorage.setItem(lastRouteKey(id), route);
    else localStorage.removeItem(lastRouteKey(id));
  } catch { /* storage unavailable: it opens on the chat list */ }
}

/** What the switch overlay shows while the app restarts as another profile, kept across the reload. */
export interface PendingSwitch { id: string; name: string; color: string; avatar?: string; at: number }
const SWITCH_KEY = "ghostly_switching";
/** A switch started in the last few seconds: the page that just loaded is its other half. */
export function pendingSwitch(): PendingSwitch | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(SWITCH_KEY) ?? "null") as PendingSwitch | null;
    return pending && typeof pending.name === "string" && Date.now() - pending.at < 15_000 ? pending : null;
  } catch { return null; }
}
export function clearPendingSwitch(): void {
  try { sessionStorage.removeItem(SWITCH_KEY); } catch { /* nothing kept */ }
}

/**
 * Makes another profile the active one and restarts the app, so no peer, wallet or timer of the old
 * profile keeps running beside the new one. Contacts of the old profile see it go offline. The profile
 * left keeps its place; the one opened goes back to its own (`route` overrides it, e.g. a new profile's
 * page). Its lock, if it has one, asks for the password before anything of it shows.
 */
export function switchProfile(id: string, options: { route?: string; avatar?: string } = {}): void {
  const registry = read();
  const target = registry.profiles.find((p) => p.id === id);
  if (!target) throw new Error("Unknown profile");
  // This page's own profile, not the registry's choice: another tab may have made that choice already.
  if (id === activeProfileId()) return;
  // A profile this device is on standby for keeps its place as it was: nothing is written into its copy (WISP 06).
  if (knownDeviceGate()?.full !== false) rememberRoute(activeProfileId());
  const pending: PendingSwitch = { id, name: shown(target).name, color: THEME_COLOR[themeOf(id)], avatar: options.avatar, at: Date.now() };
  try { sessionStorage.setItem(SWITCH_KEY, JSON.stringify(pending)); } catch { /* no overlay after the reload */ }
  window.dispatchEvent(new CustomEvent<PendingSwitch>("profile-switching", { detail: pending }));
  // A moment for the overlay to be painted: the browser keeps that frame until the new page draws. Until
  // then this page stays the old profile under it (whatever re-renders reads the registry), so the new one
  // becomes active only now, quietly.
  setTimeout(() => {
    write({ ...read(), active: id }, false);
    // Not through the router: the old profile would try to open the new one's chat first.
    window.history.replaceState(null, "", `#${options.route ?? lastRouteOf(id)}`);
    window.location.reload();
  }, 80);
}
