/**
 * Where the app's history goes. The right-hand column is a small hierarchy, not a trail of everything
 * visited:
 *
 * - **home** (`/`): the chat list and, beside it, New and Join. Always at the bottom of the app's history.
 * - **a conversation** (`/chat/…`, `/group/…`): always sits on home. Opening another one takes its place.
 * - **a place** (Wallet, Identities, Services, Settings, Profile), opened from the account bar, the phone's
 *   tab bar or the sidebar: sits on home, or on the conversation it was opened from (the browser's Back
 *   returns to that chat). Opening another place takes its place, so the browser's Back never walks
 *   through every tab visited.
 * - **a sub-page**: a page opened from inside another one (Settings → Profile, Profile → Wallets, a chat's
 *   "Manage identities"). It is pushed on its parent and its Back goes up to it; opening a page that is
 *   already below it goes back down to that one instead of stacking it again.
 *
 * A page's Back button goes up to the parent of a sub-page and home from anything else, never through the
 * history. Each entry records in its router state what lies below it, so going home is going back that
 * many entries: home is never pushed on top of the history, where the browser's Back would lead away
 * from it again. This module is the pure part (which entries, which steps); `useAppNavigation` runs it.
 */

export const HOME = "/";

/** One entry of the app's history. `up`: a sub-page, opened from the entry below it. */
export interface NavEntry {
  path: string;
  up?: boolean;
}

/** What an entry's router state records about the history under it. */
export interface NavRecord {
  /** The entries between home and this one, bottom first. */
  below: NavEntry[];
  up: boolean;
}

/** The key of the record in the router's location state, beside whatever state the page itself carries. */
export const NAV_KEY = "ghostlyNav";

/**
 * The app's history as far as this entry knows it, bottom first, ending with the entry itself. It starts
 * with home unless the entry carries no record (a deep link just opened, an address typed in): then only
 * the entry itself is known, and nothing under it may be assumed to be the app's.
 */
export interface NavStack {
  entries: NavEntry[];
  rooted: boolean;
}

/** What to do to the history: go back `back` entries, then replace the entry reached, then push these. */
export interface NavPlan {
  back: number;
  replace?: NavStep;
  push: NavStep[];
}
export interface NavStep {
  path: string;
  state: Record<string, unknown>;
}

export const isConversation = (path: string) => /^\/(?:chat|group)\/[^/]+$/.test(path);

export function readNav(state: unknown): NavRecord | null {
  const record = state && typeof state === "object" ? (state as Record<string, unknown>)[NAV_KEY] : undefined;
  if (!record || typeof record !== "object") return null;
  const { below, up } = record as Partial<NavRecord>;
  if (!Array.isArray(below) || !below.every((e) => e && typeof e.path === "string")) return null;
  return { below: below.map((e) => ({ path: e.path, ...(e.up ? { up: true } : {}) })), up: !!up };
}

/** The page's own state without the record: what a page reads, or passes on when it replaces its entry. */
export function userState(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== "object") return undefined;
  const { [NAV_KEY]: _nav, ...rest } = state as Record<string, unknown>;
  return Object.keys(rest).length ? rest : undefined;
}

export function stackOf(pathname: string, state: unknown): NavStack {
  if (pathname === HOME) return { entries: [{ path: HOME }], rooted: true };
  const nav = readNav(state);
  if (!nav) return { entries: [{ path: pathname }], rooted: false };
  return { entries: [{ path: HOME }, ...nav.below, { path: pathname, ...(nav.up ? { up: true } : {}) }], rooted: true };
}

/** The stack with home at the bottom: where a target is built from. */
const rootedEntries = (stack: NavStack) => (stack.rooted ? stack.entries : [{ path: HOME }, ...stack.entries]);
const current = (stack: NavStack) => stack.entries[stack.entries.length - 1];
const same = (a: NavEntry, b: NavEntry) => a.path === b.path && !!a.up === !!b.up;

/** Home. */
export const homeTarget = (): NavEntry[] => [{ path: HOME }];

/** A chat or a group, on home. */
export const conversationTarget = (path: string): NavEntry[] => (path === HOME ? homeTarget() : [{ path: HOME }, { path }]);

/**
 * A place of the account bar or the tab bar: on home, or on the conversation open now (or the one the
 * current page was opened over), so Back in the browser returns to that chat.
 */
export function placeTarget(stack: NavStack, path: string): NavEntry[] {
  if (path === HOME) return homeTarget();
  if (isConversation(path)) return conversationTarget(path);
  const base = rootedEntries(stack)[1];
  return base && isConversation(base.path) ? [{ path: HOME }, { path: base.path }, { path }] : [{ path: HOME }, { path }];
}

/** A page opened from inside the current one: a sub-page of it, unless it is already below (then back to it). */
export function openTarget(stack: NavStack, path: string): NavEntry[] {
  if (path === HOME) return homeTarget();
  if (isConversation(path)) return conversationTarget(path);
  const entries = rootedEntries(stack);
  const found = entries.findIndex((e) => e.path === path);
  return found > 0 ? entries.slice(0, found + 1) : [...entries, { path, up: true }];
}

/** `path` as a sub-page of `parent`, wherever it is opened from (a phone's Profile lives under Settings). */
export const openUnderTarget = (parent: string, path: string): NavEntry[] => [{ path: HOME }, { path: parent }, { path, up: true }];

/** A page's Back: up to the parent of a sub-page, home from anything else. */
export function upTarget(stack: NavStack): NavEntry[] {
  const entries = rootedEntries(stack);
  return current(stack).up && entries.length > 2 ? entries.slice(0, -1) : homeTarget();
}

/** Whether Back goes to a parent page rather than home. */
export const hasParent = (stack: NavStack) => !!current(stack).up && rootedEntries(stack).length > 2;

function stepFor(target: NavEntry[], index: number, extra?: Record<string, unknown>): NavStep {
  const entry = target[index];
  const nav: NavRecord = { below: target.slice(1, index), up: !!entry.up };
  return { path: entry.path, state: { ...extra, ...(entry.path === HOME ? {} : { [NAV_KEY]: nav }) } };
}

/**
 * The steps from the history as `stack` knows it to `target` (home first): back down to where the two
 * part, then replace and push the rest. Entries they share are reused, so a place replaces a place, and
 * going home is going back. `state` is the page state of the last entry.
 */
export function plan(stack: NavStack, target: NavEntry[], state?: Record<string, unknown>): NavPlan {
  const have = stack.entries;
  const n = have.length - 1, m = target.length - 1;
  let shared = 0;
  while (shared <= n && shared <= m && same(have[shared], target[shared])) shared++;
  if (shared > m) {
    // The target is below (or is) the current entry: back to it. New page state is set on arrival.
    return { back: n - m, ...(state ? { replace: stepFor(target, m, state) } : {}), push: [] };
  }
  const last = (i: number) => (i === m ? state : undefined);
  if (shared > n) return { back: 0, push: target.slice(shared).map((_, i) => stepFor(target, shared + i, last(shared + i))) };
  return {
    back: n - shared,
    replace: stepFor(target, shared, last(shared)),
    push: target.slice(shared + 1).map((_, i) => stepFor(target, shared + 1 + i, last(shared + 1 + i))),
  };
}

/** Only the record, without the page's own state: for a page that clears its state but stays where it is. */
export function navOnly(state: unknown): Record<string, unknown> | null {
  const nav = readNav(state);
  return nav ? { [NAV_KEY]: nav } : null;
}
