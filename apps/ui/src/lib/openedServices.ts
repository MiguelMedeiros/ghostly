/**
 * The contacts' apps this device opened, by profile and chat, so what each kept on its origin goes when the chat is
 * deleted, the profile's data is cleared or the profile is deleted. The origin is named from the chat's key: a later
 * chat never opens it again, so nothing else would clear it. The web (apps/web/src/svc/forget.ts) and Desktop
 * (desktop/host.ts) each note theirs in the shape that names their origin, and clear it their own way.
 */

/** Not under any profile's prefix (`ghostly_`): the list outlives one profile's Clear all data, and holds every profile's. */
export const OPENED_KEY = "ghostly-services-opened";

/** One contact's app this device opened: the profile (its id) and the chat (`viewerTag` of this side's key). */
export interface Opened { profile: string; tag: string }
export type ForgetServices = { tag: string } | { profile: string };

/**
 * The list, for entries of one shape: `valid` keeps those of that shape (anything else read back is dropped), and
 * `same` tells two entries for the same origin apart from the rest.
 */
export function openedServices<T extends Opened>(valid: (entry: Record<string, unknown>) => boolean, same: (a: T, b: T) => boolean) {
  const list = (): T[] => {
    try {
      const read = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "[]") as unknown;
      return Array.isArray(read)
        ? read.filter((o): o is T => !!o && typeof o === "object" && typeof o.profile === "string" && typeof o.tag === "string" && valid(o as Record<string, unknown>))
        : [];
    } catch { return []; }
  };
  const save = (entries: T[]) => {
    try {
      if (entries.length) localStorage.setItem(OPENED_KEY, JSON.stringify(entries));
      else localStorage.removeItem(OPENED_KEY);
    } catch { /* storage full: the open goes on, its origin is only not cleared later */ }
  };
  return {
    list,
    /** Noted before the app opens: whatever it keeps there from then on is cleared with the chat. */
    note(opened: T): void {
      const entries = list();
      if (!entries.some((o) => same(o, opened))) save([...entries, opened]);
    },
    /**
     * Clears the origins of the apps opened from one chat (`tag`) or by one profile (`profile`), one at a time or, with
     * `atOnce`, all together, and takes each one cleared off the list. One `clear` did not clear (false, or it threw)
     * stays on it, for the profile's next clear.
     */
    async forget(which: ForgetServices, clear: (opened: T) => Promise<boolean>, atOnce = false): Promise<void> {
      const matches = (o: T) => ("tag" in which ? o.tag === which.tag : o.profile === which.profile);
      const one = async (opened: T) => {
        if (await clear(opened).catch(() => false)) save(list().filter((o) => !same(o, opened)));
      };
      const all = list().filter(matches);
      if (atOnce) await Promise.all(all.map(one));
      else for (const opened of all) await one(opened);
    },
  };
}
