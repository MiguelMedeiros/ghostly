import { useSyncExternalStore } from "react";

/*
 * Whether the page can be seen at all: false while it is hidden (the Desktop window closed to the Dock or minimised, a
 * browser tab in the background). A chat open in a hidden page has not been read: what comes meanwhile stays unread,
 * so the icon's badge counts it, until the page shows again.
 */

const subscribe = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const shown = () => document.visibilityState !== "hidden";

/** False while the page is hidden. Not the focus: a window on screen beside another app's is read. */
export function usePageShown(): boolean {
  return useSyncExternalStore(subscribe, shown, () => true);
}
