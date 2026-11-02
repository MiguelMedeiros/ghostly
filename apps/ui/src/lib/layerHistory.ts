/**
 * Back (Android's back gesture, the browser's) with a dialog, a sheet or a menu open closes that layer alone and
 * leaves the page under it as it was. Each open layer has a history entry of its own over the page's: the same
 * address and the router's own state (the router sees the same entry), marked with how many layers are open on it.
 * Back from it closes the layers above the entry reached. A layer closed another way (Cancel, a tap outside, Escape,
 * what it did) takes its entry with it. A move of the app's own (`useAppNavigation`) first goes back off the layers'
 * entries, so its steps count the page's entries only; a layer still open once it is made gets an entry over the page
 * it led to. An entry left with no layer on it (a page pushed over an open layer, then Back; Forward onto one) is not
 * a place to stop: the page goes on to the one under it.
 */
const MARK = "ghostlyLayer";

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

const depthOf = (state: unknown): number => {
  const depth = state && typeof state === "object" ? (state as Record<string, unknown>)[MARK] : undefined;
  return typeof depth === "number" ? depth : 0;
};
const busy = () => !!going && Date.now() - going.at < GOING_MS;

// A page that starts on a layer's entry (reloaded with a dialog open, as a move or a takeover of the profile does) has
// no layer open: that entry is the page's own now. Gone back off, it would leave this page for the one before the
// reload, and the move waiting for it would never run (a chat tapped in the list stayed on Profile).
if (typeof window !== "undefined" && typeof history !== "undefined" && depthOf(history.state)) {
  const { [MARK]: _gone, ...state } = history.state as Record<string, unknown>;
  history.replaceState(state, "");
}

/** The history to what is open: an entry pushed for each layer opened, gone back over each one closed. */
function settle() {
  if (leaving) return;
  // On its way somewhere: looked at again once it has landed.
  if (busy()) { setTimeout(settle, 50); return; }
  scheduled = false;
  const here = depthOf(history.state);
  if (open.length > here) {
    const state = (history.state ?? {}) as Record<string, unknown>;
    for (let depth = here + 1; depth <= open.length; depth++) history.pushState({ ...state, [MARK]: depth }, "");
  } else if (open.length < here) {
    going = { at: Date.now() };
    history.go(open.length - here);
  }
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
  // The person's Back: the layers over the entry it reached close. One of ours: what waited for it.
  if (!landed) for (const layer of open.splice(depthOf(history.state)).reverse()) layer.close();
  else landed.then?.();
  schedule();
}

/** A layer opened: Back closes it with `close`. Returns what to call once it is closed. */
export function openLayer(close: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (!watching) { watching = true; addEventListener("popstate", onPop); }
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
  if (typeof window !== "undefined") going = { at: Date.now() };
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
