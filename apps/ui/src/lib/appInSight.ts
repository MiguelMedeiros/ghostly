import { getPrefix } from "./storage";
import { windowAway } from "./windowAway";

/**
 * Whether any page of the app is in sight, not only this one. The extension's tabs share one engine, so a call or a
 * message reaches each of them: a tab in the background told the person with a system notification about the call
 * ringing, or the chat open, in the tab in front of them. A page in sight holds a lock the other pages can see, which
 * goes with the page. One per profile: the web app may run two profiles in two tabs, and each tells its own.
 */
const prefix = () => `ghostly-in-sight:${getPrefix()}:`;
/** This page's own lock has a name of its own: one it let go a moment ago may still be listed, and must not count. */
const page = Math.random().toString(36).slice(2);

let holding: { name: string; letGo: () => void } | null = null;
let watching = false;

function update(): void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return;
  const name = prefix() + page;
  if (holding && (windowAway() || holding.name !== name)) {
    holding.letGo();
    holding = null;
  }
  if (holding || windowAway()) return;
  let letGo!: () => void;
  const gone = new Promise<void>((resolve) => { letGo = resolve; });
  holding = { name, letGo };
  void locks.request(name, () => gone).catch(() => {});
}

/** Holds the lock while this page is in sight, from the first call on. Safe to call again. */
export function watchAppInSight(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pageshow", update);
  document.addEventListener("visibilitychange", update);
  update();
}

/** Tests only: reads the window again. */
export function refreshAppInSight(): void {
  if (watching) update();
}

/**
 * This page is away (`windowAway`) and no other page of this profile is in sight: what a system notification is for.
 * Where locks cannot be read, this page alone decides, as before.
 */
export async function appAway(): Promise<boolean> {
  if (!windowAway()) return false;
  try {
    const { held = [] } = (await navigator.locks?.query()) ?? {};
    const others = prefix(), mine = others + page;
    return !held.some((lock) => lock.name?.startsWith(others) && lock.name !== mine);
  } catch {
    return true;
  }
}
