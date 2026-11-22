/**
 * Back (Android's back gesture, the browser's) with a dialog, a sheet or a menu open closes that layer alone and
 * leaves the page under it as it was. Each open layer has a history entry of its own over the page's: the same
 * address and the router's own state (the router sees the same entry), marked with how many layers are open on it.
 * Back from it closes the layers above the entry reached. A layer closed another way (Cancel, a tap outside, Escape,
 * what it did) leaves its entry where it is, a mark over what is still open: a traversal of the page's own then could
 * land as a navigation starts (the browser's reload right after Escape) and cancel it or drop it (Chromium). The next
 * layer opened takes that entry; the person's Back from it, with nothing above the entry it reaches to close, does what
 * that Back would have done had the entry been gone: it closes the layer on top, or leaves the page. A move of the
 * app's own (`useAppNavigation`) first goes back off the layers' entries, so its steps count the page's entries only;
 * a layer still open once it is made gets an entry over the page it led to. An entry with no layer on it reached
 * another way (a page pushed over an open layer, then Back; Forward onto one) is the page's, as such a mark is.
 */
const MARK = "ghostlyLayer";
/** On a page's own entry: how many of its entries from before a reload are under it. */
const UNDER = "ghostlyUnder";

interface Layer { close: () => void }
/** The open layers, the first opened first. */
const open: Layer[] = [];
/** A traversal of ours on its way (it answers with a popstate), with what runs once it lands. */
let going: { at: number; then?: () => void } | null = null;
/** Past this, a traversal that never answered is given up on. */
const GOING_MS = 1500;
let scheduled = false;
let watching = false;
/** The page reloads (`reloadPage`): the history is left as it is. */
let leaving = false;
/** The entry the page was last seen on: its page (the state under the mark, the address) and its depth. */
let last: { page: string; depth: number } | null = null;
/** The layers `onPop` closes are closed by a move onto another page, not by Back (`closedByArrival`). */
let arrived = false;

const depthOf = (state: unknown): number => {
  const depth = state && typeof state === "object" ? (state as Record<string, unknown>)[MARK] : undefined;
  return typeof depth === "number" ? depth : 0;
};
const underOf = (state: unknown): number => {
  const under = state && typeof state === "object" ? (state as Record<string, unknown>)[UNDER] : undefined;
  return typeof under === "number" ? under : 0;
};
const pageOf = (state: unknown): string => {
  const { [MARK]: _depth, ...rest } = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return `${location.href} ${JSON.stringify(rest)}`;
};
const seen = () => { last = { page: pageOf(history.state), depth: depthOf(history.state) }; };
const busy = () => !!going && Date.now() - going.at < GOING_MS;

/**
 * A page that starts on a layer's entry (reloaded with a dialog open, as a move or a takeover of the profile does, or
 * after a layer closed another way) has no layer open: that entry is the page's own now. Gone back off, it would leave
 * this page for the one before the reload, and the move waiting for it would never run (a chat tapped in the list
 * stayed on Profile). The entries under it are this page's still, of the page before the reload: they are counted
 * (`UNDER`), and the app's own moves back go over them too. Run as the page starts.
 */
export function adoptEntry(): void {
  if (typeof window === "undefined" || typeof history === "undefined" || !depthOf(history.state)) return;
  const { [MARK]: depth, ...state } = history.state as Record<string, unknown>;
  history.replaceState({ ...state, [UNDER]: underOf(state) + (depth as number) }, "");
}
adoptEntry();

/** How many entries of this page's, left under the one it is on by a reload, a move of the app's back goes over too. */
export function pagesUnder(): number {
  return typeof history === "undefined" ? 0 : underOf(history.state);
}

/** An entry pushed for each layer opened over those the entry the page is on has: it never goes back by itself. */
function settle() {
  if (leaving) return;
  // On its way somewhere: looked at again once it has landed.
  if (busy()) { setTimeout(settle, 50); return; }
  scheduled = false;
  const here = depthOf(history.state);
  if (open.length > here) {
    const state = (history.state ?? {}) as Record<string, unknown>;
    for (let depth = here + 1; depth <= open.length; depth++) history.pushState({ ...state, [MARK]: depth }, "");
  }
  seen();
}

/**
 * Once the changes of one go are in: a menu that closes as the dialog it opened opens keeps the one entry, and a tap
 * outside a menu onto a link lets the link's page in first (its click comes after the pointerup that closed the menu).
 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(settle, 0);
}

function onPop() {
  const landed = going;
  going = null;
  const from = last;
  seen();
  if (landed) { landed.then?.(); schedule(); return; }
  // The person's Back: the layers over the entry it reached close.
  const depth = depthOf(history.state);
  const closing = open.splice(depth).reverse();
  arrived = !!from && from.page !== last!.page;
  try { for (const layer of closing) layer.close(); } finally { arrived = false; }
  // Back off an entry a layer closed another way left, over what was still open: that Back would show nothing. It
  // closes the layer on top, or with none, leaves the page, as it would have with that entry gone.
  if (!closing.length && from && from.page === last!.page && depth < from.depth) {
    const top = open.pop();
    if (top) top.close();
    else history.go(-depth - 1);
  }
  schedule();
}

/**
 * Asked by a layer as it is closed: the entry reached is another page's (a link put in the address, `location.hash =`),
 * not the one under the layers. A layer that is a question (NameStep) stays: that is no answer.
 */
export function closedByArrival(): boolean {
  return arrived;
}

/**
 * From the first layer opened or the first traversal of the app's own, whichever comes first: a traversal that landed
 * with nobody watching stayed `going`, and the person's next Back was taken for it (the layer over the page stayed, or
 * within GOING_MS of it, got no entry and Back left the page).
 */
function watch() {
  if (watching) return;
  watching = true;
  addEventListener("popstate", onPop);
}

/** A layer opened: Back closes it with `close`. Returns what to call once it is closed. */
export function openLayer(close: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  watch();
  const layer = { close };
  open.push(layer);
  schedule();
  return () => {
    const at = open.indexOf(layer);
    if (at < 0) return;
    open.splice(at, 1);
    schedule();
  };
}

/** A traversal of the app's own is on its way: no entry is pushed until it lands. */
export function traversing(): void {
  if (typeof window === "undefined") return;
  watch();
  going = { at: Date.now() };
}

/** Runs `then` once the history is off the layers' entries, back on the page's own. */
export function afterLayers(then: () => void): void {
  // No history where the page runs without a DOM (the engine's tests stand in a `window` without one).
  if (typeof window === "undefined" || typeof history === "undefined") { then(); return; }
  const here = depthOf(history.state);
  if (!here) { then(); return; }
  if (busy()) {
    const before = going!.then;
    going!.then = () => { before?.(); afterLayers(then); };
    return;
  }
  watch();
  going = { at: Date.now(), then };
  history.go(-here);
}

/**
 * Reloads the page once the history is off the layers' entries, and leaves it be from then on. A layer closed as the
 * reload starts (the dialog a move ends in, gone with the page under it) went back over its entry after the reload had
 * started, which cancels the reload (Chromium): the device that gave its profile away stayed on "Moving to another
 * device" and never answered the other one.
 */
export function reloadPage(reload: () => void = () => window.location.reload()): void {
  afterLayers(() => { leaving = true; reload(); });
}
