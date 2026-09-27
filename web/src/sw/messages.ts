import type { SharedItem } from "./policy";

/** What a page of the app says to its service worker. */
export type ToWorker =
  /** The user pressed Reload on a new version: the waiting worker takes over now. Never sent on its own. */
  | { type: "skip-waiting" }
  /** This page is the app (it holds the peer) and opened for a share: hand it over. */
  | { type: "share-ready" }
  /** This page opened for a share but another tab of the app holds the peer: give the share to that one. */
  | { type: "share-forward" };

/** What the service worker says to a page. */
export type FromWorker =
  | { type: "share"; item: SharedItem }
  /** Asked for a share, and there is none (it was already taken, or it timed out). */
  | { type: "share-none" };

/** How long a shared item waits for the app to ask for it. Past that it is dropped, never stored. */
export const SHARE_HOLD_MS = 2 * 60_000;
