import type { SharedItem } from "./policy";

/** What a page of the app says to its service worker. */
export type ToWorker =
  /** The user pressed Reload on a new version: the waiting worker takes over now. Never sent on its own. */
  | { type: "skip-waiting" }
  /** This page is the app (it holds the peer) and opened for a share: hand it over. */
  | { type: "share-ready" }
  /** This page opened for a share but another tab of `profile` holds the peer: give the share to that one. */
  | { type: "share-forward"; profile: string }
  /**
   * This page holds `profile`'s peer and takes shares: said when it starts and whenever it comes to the front. `lock`:
   * the holder of that peer lock as Web Locks names it, which a forward checks is still held.
   */
  | { type: "share-here"; profile: string; lock?: string }
  /** This page that took shares goes (a share into the same window replaces it): none is forwarded to it on its way out. */
  | { type: "share-away" }
  /** This page restarts (a profile switch) with a share still in its picker: hold it again for the page that loads next. */
  | { type: "share-keep"; item: SharedItem }
  /** Opens a wake-up notification's chat as a tap would (the push worker; a page of this origin only). */
  | { type: "open-notification"; tag: string };

/** What the service worker says to a page. */
export type FromWorker =
  /** A share held for this page; with the last handed over, how many posted meanwhile it could not keep. */
  | { type: "share"; item: SharedItem; dropped?: number }
  /** Asked for a share, and there is none (it was already taken, or it timed out). */
  | { type: "share-none" }
  /** The shares this page asked to forward (`share-forward`) are handed to the app's page of its profile. */
  | { type: "share-forwarded" }
  /**
   * A share is to be forwarded and no page of its profile said `share-here` in this worker's life (it restarted since):
   * a page that takes shares says it again now, without coming to the front.
   */
  | { type: "share-where" }
  /** A wake-up notification was tapped: open this chat, in this profile (switching to it when another is open). */
  | { type: "open-chat"; path: string; profile: string }
  /** A wake-up notification was tapped: which profile does this window run, and does it hold its peer? Answered on the port sent with it (`WindowSays`). */
  | { type: "open-ask" }
  /** A hashed file of this build is gone from the server: a deploy replaced it, so the page looks for the new version now. */
  | { type: "build-gone" };

/** A window's answer to `open-ask`: the profile it runs, and whether it holds that profile's peer (false: it waits behind another tab, or has not started yet). */
export type WindowSays = { profile: string; peer: boolean };

/** How long the push worker waits for the windows to answer `open-ask`. A page that says nothing by then is of an older build, or frozen. */
export const OPEN_ASK_MS = 500;

/** How long a shared item waits for the app to ask for it. Past that it is dropped, never stored. */
export const SHARE_HOLD_MS = 2 * 60_000;

/**
 * A share is forwarded only to the app's page that holds its profile's peer lock on two looks this far apart: a page
 * on its way out (a share into its own window replaced it) lets go of the lock by then, a live one still holds it.
 */
export const SHARE_LOCK_LOOK_MS = 1000;

/**
 * Most shares held at once, the worker's and a page's picker's each: one past that is dropped, never one that waits,
 * and the page that takes the others says how many.
 */
export const MAX_HELD_SHARES = 3;
