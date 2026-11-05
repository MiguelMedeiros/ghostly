import { prefixOf } from "./profiles";
import { verifyPassword } from "./settings";

/*
 * Wrong lock passwords are paced wherever a profile's lock password is checked: its lock screen, and another profile's
 * Delete and Back up first (`assertUnlocked`). Each profile has its own count, in its own storage, kept across reloads
 * or reloading would reset it; only that profile's right password clears it. The default profile's key,
 * `ghostly_lock_attempts`, is the one every profile shared before: a wait kept there stays the default profile's.
 */

/** Failures allowed before the wait starts; then it doubles from 1 s, up to 5 minutes. */
const FREE_ATTEMPTS = 3;
const MAX_DELAY_MS = 5 * 60_000;

interface Attempts {
  failures: number;
  retryAt: number;
}

const keyOf = (id: string) => `${prefixOf(id)}lock_attempts`;

function loadAttempts(id: string): Attempts {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyOf(id)) ?? "") as Partial<Attempts>;
    return { failures: Number(parsed.failures) || 0, retryAt: Number(parsed.retryAt) || 0 };
  } catch {
    return { failures: 0, retryAt: 0 };
  }
}

function saveAttempts(id: string, attempts: Attempts | null): void {
  try {
    if (attempts) localStorage.setItem(keyOf(id), JSON.stringify(attempts));
    else localStorage.removeItem(keyOf(id));
  } catch {
    // storage unavailable
  }
}

/** When the next try at profile `id`'s lock password is accepted, while it must wait. */
export function lockRetryAt(id: string): number | null {
  const { retryAt } = loadAttempts(id);
  return retryAt > Date.now() ? retryAt : null;
}

/** The Web Lock the app's pages of one origin take turns on to try a password (`tryLockPassword`). */
const ATTEMPTS_LOCK = "ghostly-unlock";

/**
 * Runs one try at the password while no other page of the app runs one: the extension opens the app in as many tabs
 * as one likes, and tries made in them at once would otherwise all read the same count and fit in one paced slot.
 */
function oneTryAtATime<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return typeof locks?.request === "function" ? (locks.request(ATTEMPTS_LOCK, run) as Promise<T>) : run();
}

type Tried = { ok: boolean; retryAt: number | null; waited?: true };

/**
 * `password` checked against profile `id`'s lock (`hash`), paced. `retryAt`: when the next try is accepted, while it
 * must wait; `waited`: this one was not checked at all, the wait was not over.
 */
export function tryLockPassword(id: string, password: string, hash: string): Promise<Tried> {
  return oneTryAtATime(() => tryOnce(id, password, hash));
}

async function tryOnce(id: string, password: string, hash: string): Promise<Tried> {
  const attempts = loadAttempts(id);
  if (attempts.retryAt > Date.now()) return { ok: false, retryAt: attempts.retryAt, waited: true };
  const failures = attempts.failures + 1;
  const delay = failures < FREE_ATTEMPTS ? 0 : Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - FREE_ATTEMPTS));
  // Counted as a failure before it is checked: tries made while this one is being checked find it counted.
  saveAttempts(id, { failures, retryAt: delay ? Date.now() + delay : 0 });
  if (await verifyPassword(password, hash)) {
    saveAttempts(id, null);
    return { ok: true, retryAt: null };
  }
  const retryAt = delay ? Date.now() + delay : 0;
  saveAttempts(id, { failures, retryAt });
  return { ok: false, retryAt: retryAt || null };
}

/** What a try refused for the wait says. */
export const waitMessage = (retryAt: number) => `Too many attempts. Try again in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} s`;
