import { protocolLinkCode } from "./url";

/**
 * A link opened while the profile runs in another tab (an invite, a group's link, a device code): the tab it opened
 * in waits for the profile's lock, so it hands the link to the tab that holds it, as a share is handed over. Over a
 * channel of the profile's own, named after its peer lock, so another profile's tab never takes it.
 */
type LinkMessage = { type: "link"; id: string; route: string } | { type: "link-taken" | "link-dropped"; id: string };

const channelName = (lock: string) => `${lock}-links`;

/**
 * The route of the link this address carries (the hash without its `#`), when it carries one the app's intakes take:
 * a `ghostly1` invite or device code, a `web+ghostly:` link, a group's `/join/…` link, or a device code's link that
 * names the profile (`#<profile>#ghostly1z…`). Null for anything else: home, a chat's address, a page of the menu.
 */
export function linkInAddress(hash: string): string | null {
  const route = hash.replace(/^#/, "");
  const pathname = route.split(/[?#]/)[0];
  if (/^\/?ghostly1/i.test(pathname) || protocolLinkCode(pathname) !== null || /^\/join\/./.test(pathname)) return route;
  return /#ghostly1/i.test(route) ? route : null;
}

/**
 * Hands `route` to the tab that holds `lock`, every `everyMs` until one takes it (the first ask can come before that
 * tab listens), and calls `onTaken` once one did, or `onDropped` once one on standby refused it (`dropLinks`). Returns
 * what stops it: this tab took the lock itself.
 */
export function forwardLink(lock: string, route: string, onTaken: () => void, everyMs: number, onDropped: () => void = onTaken): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(channelName(lock));
  const id = crypto.randomUUID();
  const ask = () => channel.postMessage({ type: "link", id, route } satisfies LinkMessage);
  const timer = setInterval(ask, everyMs);
  const stop = () => { clearInterval(timer); channel.close(); };
  channel.onmessage = (event: MessageEvent<LinkMessage>) => {
    const answer = event.data?.type;
    if ((answer !== "link-taken" && answer !== "link-dropped") || event.data.id !== id) return;
    stop();
    if (answer === "link-taken") onTaken();
    else onDropped();
  };
  return stop;
}

/** This tab holds `lock`: a link another tab hands over goes to `open`, once, and that tab hears it was taken. */
export function takeLinks(lock: string, open: (route: string) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(channelName(lock));
  const taken = new Set<string>();
  channel.onmessage = (event: MessageEvent<LinkMessage>) => {
    const message = event.data;
    if (message?.type !== "link" || typeof message.route !== "string" || linkInAddress(message.route) === null) return;
    channel.postMessage({ type: "link-taken", id: message.id } satisfies LinkMessage);
    if (taken.has(message.id)) return;
    taken.add(message.id);
    open(message.route);
  };
  return () => channel.close();
}

/**
 * This tab holds `lock` on a device on standby (WISP 06 § The gate): it opens no link, and a link another tab hands
 * over is refused at once, so that tab drops it from its address rather than keeping it there for a tab that never will.
 */
export function dropLinks(lock: string): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(channelName(lock));
  channel.onmessage = (event: MessageEvent<LinkMessage>) => {
    const message = event.data;
    if (message?.type === "link" && typeof message.id === "string") channel.postMessage({ type: "link-dropped", id: message.id } satisfies LinkMessage);
  };
  return () => channel.close();
}
