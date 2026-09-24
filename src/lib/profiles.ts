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
}
interface Registry { version: 1; active: string; profiles: ProfileEntry[] }

/** Desktop's GHOSTLY_PROFILE: the process's own space, with its own profiles inside (for side-by-side testing). */
let base = "";
export function setProfileBase(name: string): void { base = name; }
/** The registry of this space. */
export const registryKey = () => (base ? `ghostly_${base}_profiles` : "ghostly_profiles");
/** The storage namespace of a profile: its prefix `ghostly_<ns>_`, database `ghostly_<ns>`, lock `ghostly-peer-<ns>`. */
export const namespaceOf = (id: string) => (id ? (base ? `${base}-${id}` : id) : base);
const ID = /^[a-z0-9]{10}$/;
export const PROFILE_THEMES: ColorTheme[] = ["cyan", "purple", "classic", "monochrome"];
/** The swatch each theme shows in the switcher and on the profile's avatar. */
export const THEME_COLOR: Record<ColorTheme, string> = { cyan: "#22d3ee", purple: "#a78bfa", classic: "#00a884", monochrome: "#d4d4d8" };
const DEFAULT_ENTRY: ProfileEntry = { id: "", name: "Personal", createdAt: 0 };


function read(): Registry {
  try {
    const raw = JSON.parse(localStorage.getItem(registryKey()) ?? "null") as Partial<Registry> | null;
    const profiles = (Array.isArray(raw?.profiles) ? raw!.profiles : [])
      .filter((p): p is ProfileEntry => !!p && typeof p.id === "string" && (p.id === "" || ID.test(p.id)) && typeof p.name === "string")
      .map((p) => ({ id: p.id, name: cleanName(p.name) || (p.id ? "Profile" : DEFAULT_ENTRY.name), createdAt: Number(p.createdAt) || 0 }));
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

export function listProfiles(): ProfileEntry[] { return read().profiles; }
/** The profile to start as: the one last chosen in this space. */
export function activeProfileId(): string { return read().active; }
export function currentProfile(): ProfileEntry {
  const id = activeProfileId();
  return read().profiles.find((p) => p.id === id) ?? { id, name: id || DEFAULT_ENTRY.name, createdAt: 0 };
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
  const clean = cleanName(name);
  if (!clean) throw new Error("Give the profile a name");
  const registry = read();
  const used = registry.profiles.map((p) => themeOf(p.id));
  const theme = PROFILE_THEMES.find((t) => !used.includes(t)) ?? PROFILE_THEMES[registry.profiles.length % PROFILE_THEMES.length];
  const id = newProfileId();
  let inherited: Record<string, unknown> = {};
  try {
    const current = JSON.parse(localStorage.getItem(settingsKeyFor(activeProfileId())) ?? "{}") as Record<string, unknown>;
    // The lock goes with it: a new profile must not be a way around the lock of the one it came from.
    inherited = { language: current.language, colorScheme: current.colorScheme, theme: current.colorScheme, lockScreen: current.lockScreen };
  } catch { /* defaults */ }
  localStorage.setItem(settingsKeyFor(id), JSON.stringify({ ...inherited, colorTheme: theme }));
  const entry = { id, name: clean, createdAt: Date.now() };
  write({ ...registry, profiles: [...registry.profiles, entry] });
  return entry;
}

/** A fresh id no profile of this space uses yet. */
export function newProfileId(): string {
  const taken = new Set(read().profiles.map((p) => p.id));
  const draw = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  let id = draw();
  while (taken.has(id)) id = draw();
  return id;
}

/** Adds a profile whose data is already in place (a restored backup, WISP 05). */
export function registerProfile(id: string, name: string): ProfileEntry {
  if (!ID.test(id)) throw new Error("Invalid profile id");
  const registry = read();
  if (registry.profiles.some((p) => p.id === id)) throw new Error("That profile already exists");
  const entry = { id, name: cleanName(name) || "Restored", createdAt: Date.now() };
  write({ ...registry, profiles: [...registry.profiles, entry] });
  return entry;
}

/** Takes a profile off the list. Its data must already be gone (see profileData). */
export function unregisterProfile(id: string): void {
  if (!id) throw new Error("The first profile cannot be removed");
  const registry = read();
  if (registry.active === id) throw new Error("Switch to another profile first");
  write({ ...registry, profiles: registry.profiles.filter((p) => p.id !== id) });
}

export function renameProfile(id: string, name: string): void {
  const clean = cleanName(name);
  if (!clean) throw new Error("Give the profile a name");
  const registry = read();
  write({ ...registry, profiles: registry.profiles.map((p) => (p.id === id ? { ...p, name: clean } : p)) });
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
  if (id === registry.active) return;
  rememberRoute(registry.active);
  const pending: PendingSwitch = { id, name: target.name, color: THEME_COLOR[themeOf(id)], avatar: options.avatar, at: Date.now() };
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
