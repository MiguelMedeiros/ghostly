import { isValidServiceId } from "@ghostly/core";

/**
 * Virtual origin of a remote service: `https://<service id>.<peer key>.ghostly.invalid`.
 * `.invalid` is reserved (RFC 2606) and can never resolve, so nothing leaks to
 * the network if a request is ever not intercepted. One origin per peer and
 * service keeps the storage of different peers' applications apart.
 */
const VIEWER_SUFFIX = ".ghostly.invalid";
export const VIEWER_URL_PATTERN = `https://*${VIEWER_SUFFIX}/*`;
const PEER_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

export function viewerUrl(peerPubKeyZ32: string, serviceId: string, path = "/"): string {
  return `https://${serviceId}.${peerPubKeyZ32}${VIEWER_SUFFIX}${path}`;
}

export function parseViewerUrl(input: string): { peerPubKeyZ32: string; serviceId: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || !url.hostname.endsWith(VIEWER_SUFFIX)) return null;
  const labels = url.hostname.slice(0, -VIEWER_SUFFIX.length).split(".");
  if (labels.length !== 2) return null;
  const [serviceId, peerPubKeyZ32] = labels;
  if (!isValidServiceId(serviceId) || !PEER_KEY.test(peerPubKeyZ32)) return null;
  return { peerPubKeyZ32, serviceId, path: `${url.pathname}${url.search}` };
}
