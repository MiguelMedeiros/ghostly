import { isValidServiceId, isViewerTag, isZ32Key } from "@ghostly/core";

/**
 * Virtual origin of a remote service: `https://<service id>.<peer key>.<tag>.invalid`.
 * `.invalid` is reserved (RFC 2606) and can never resolve, so nothing leaks to
 * the network if a request is ever not intercepted. One origin per peer and
 * service keeps the storage of different peers' applications apart.
 *
 * The tag (`viewerTag`) comes from this profile's key for the chat with that
 * peer, and sits right under `.invalid` so that each chat is a site of its own:
 * `.invalid` is a top-level domain to the browser, so a page can scope a cookie
 * to its own chat (`Domain=<tag>.invalid`) but never to another one, and one
 * peer's app is cross-site to every other peer's. Every Ghostly profile shares
 * the browser's storage, so without the tag a profile, or the same profile after
 * "Clear all data", would find what the app kept for another (WISP 04).
 */
const VIEWER_SUFFIX = ".invalid";
export const VIEWER_URL_PATTERN = `https://*${VIEWER_SUFFIX}/*`;

export function viewerUrl(peerPubKeyZ32: string, serviceId: string, tag: string, path = "/"): string {
  return `https://${serviceId}.${peerPubKeyZ32}.${tag}${VIEWER_SUFFIX}${path}`;
}

export function parseViewerUrl(input: string): { peerPubKeyZ32: string; serviceId: string; tag: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || !url.hostname.endsWith(VIEWER_SUFFIX)) return null;
  const labels = url.hostname.slice(0, -VIEWER_SUFFIX.length).split(".");
  if (labels.length !== 3) return null;
  const [serviceId, peerPubKeyZ32, tag] = labels;
  if (!isValidServiceId(serviceId) || !isZ32Key(peerPubKeyZ32) || !isViewerTag(tag)) return null;
  return { peerPubKeyZ32, serviceId, tag, path: `${url.pathname}${url.search}` };
}
