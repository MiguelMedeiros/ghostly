import type { SharedItem } from "./policy";

/** What a page of the app says to its service worker. */
export type ToWorker =
  /** The user pressed Reload on a new version: the waiting worker takes over now. Never sent on its own. */
  | { type: "skip-waiting" }
  /** This page is the app (it holds the peer) and opened for a share: hand it over. */
  | { type: "share-ready" }
  /** This page opened for a share but another tab of the app holds the peer: give the share to that one. */
  | { type: "share-forward" }
  /** Opens a wake-up notification's chat as a tap would (the push worker; a page of this origin only). */
  | { type: "open-notification"; tag: string };

/** What the service worker says to a page. */
export type FromWorker =
  | { type: "share"; item: SharedItem }
  /** Asked for a share, and there is none (it was already taken, or it timed out). */
  | { type: "share-none" }
  /** A wake-up notification was tapped: open this chat, in this profile (switching to it when another is open). */
  | { type: "open-chat"; path: string; profile: string };

/** How long a shared item waits for the app to ask for it. Past that it is dropped, never stored. */
export const SHARE_HOLD_MS = 2 * 60_000;
