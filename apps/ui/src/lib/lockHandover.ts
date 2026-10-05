/*
 * The lock passed once, carried across one reload the app itself makes (WISP 06 § User experience): adding this device
 * to a profile makes a new profile behind the same lock and switches to it, then starts again into the standby screen.
 * The person just typed the password in this tab; asking it twice more for the same lock says nothing new. The page,
 * unlocked, writes a marker for the profile it reloads into, with that profile's password hash, just before it reloads;
 * the next page takes it at once. It counts only for that profile, only while the hash is the same, and only within a
 * few seconds; a reload the person makes, or any later one, asks for the password as always.
 */
const HANDOVER_KEY = "ghostly_unlock_handover";
const HANDOVER_MS = 15_000;

/** Hands the lock already passed in this tab to the page that `profile` reloads into next. Only from an unlocked page. */
export function handOverUnlock(profile: string, passwordHash: string | null | undefined): void {
  if (!passwordHash) return;
  try { sessionStorage.setItem(HANDOVER_KEY, JSON.stringify({ profile, hash: passwordHash, at: Date.now() })); } catch { /* the lock asks */ }
}

/** What this page took of a handover, once (a render may ask twice): for which profile, and whether it counts. */
let taken: { profile: string; ok: boolean; at: number } | null = null;

/** Whether this page starts unlocked: a fresh handover for this profile and this password hash, used up as it is read. */
export function takeUnlockHandover(profile: string, passwordHash: string | null | undefined, now = Date.now()): boolean {
  if (taken && taken.profile === profile && now >= taken.at && now - taken.at < 2_000) return taken.ok;
  let ok: boolean;
  try {
    const raw = sessionStorage.getItem(HANDOVER_KEY);
    sessionStorage.removeItem(HANDOVER_KEY);
    const marker = raw ? JSON.parse(raw) as { profile?: unknown; hash?: unknown; at?: unknown } : null;
    ok = !!marker && !!passwordHash && marker.profile === profile && marker.hash === passwordHash
      && typeof marker.at === "number" && now >= marker.at && now - marker.at < HANDOVER_MS;
  } catch { ok = false; }
  taken = { profile, ok, at: now };
  return ok;
}
