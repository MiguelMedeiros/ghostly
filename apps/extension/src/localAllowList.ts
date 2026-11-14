import { webLocalFetch, type LocalFetch } from "@ghostly/core";
import { localAccessPattern } from "@ghostly/browser/host";
import type { RuntimeMessage } from "./messages";

/**
 * The exact addresses (`http://localhost:3400`) a profile's person allowed in this browser, by a click: the only ones
 * its peer reaches for a contact. Kept in `storage.local`, outside the profile, so neither a backup restored nor a
 * profile moved here brings any; Chrome's permission, for the whole host and every profile, is not enough alone.
 *
 * Read and written by the pages and the worker. The offscreen document, where the peer runs, has `chrome.runtime` and
 * nothing else of Chrome's: its peer asks the worker (`allowedLocalFetch`).
 */
export const ALLOWED_PREFIX = "localAccessAllowed:";
export const allowedKey = (ns: string) => `${ALLOWED_PREFIX}${ns}`;

export async function allowedOrigins(ns: string): Promise<string[]> {
  const list = (await chrome.storage.local.get(allowedKey(ns)))[allowedKey(ns)];
  return Array.isArray(list) ? list.filter((o): o is string => typeof o === "string") : [];
}

/** The person allowed `origin` for profile `ns` (Chrome's prompt said yes to its host). */
export async function allowLocalOrigin(ns: string, origin: string): Promise<void> {
  const list = await allowedOrigins(ns);
  if (!list.includes(origin)) await chrome.storage.local.set({ [allowedKey(ns)]: [...list, origin] });
}

/** Takes `origin` off profile `ns`'s list. */
export async function disallowLocalOrigin(ns: string, origin: string): Promise<void> {
  const list = await allowedOrigins(ns);
  if (list.includes(origin)) await chrome.storage.local.set({ [allowedKey(ns)]: list.filter((o) => o !== origin) });
}

/** May profile `ns`'s peer reach `origin` for a contact: allowed here by its person, and Chrome still grants the host. */
export async function localOriginAllowed(ns: string, origin: string): Promise<boolean> {
  if (!(await allowedOrigins(ns)).includes(origin)) return false;
  return chrome.permissions.contains({ origins: [localAccessPattern(origin)] }).catch(() => false);
}

/**
 * The offscreen peer's `localFetch` for profile `ns`: the worker says whether the address is allowed (`localOriginAllowed`,
 * background.ts), and one not allowed, or no answer, is never reached.
 */
export const allowedLocalFetch = (ns: string): LocalFetch => async (request) => {
  const origin = new URL(request.url).origin;
  const allowed = await chrome.runtime.sendMessage({ target: "background", type: "local-access-allowed", profile: ns, origin } satisfies RuntimeMessage).catch(() => false);
  if (allowed !== true) throw new Error("That local address is not allowed in this browser");
  return webLocalFetch(request);
};
