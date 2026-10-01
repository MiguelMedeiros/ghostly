/**
 * Whether a message or a port comes from the extension itself: its pages, its offscreen document or its service
 * worker. No web page or other extension can reach the extension's listeners (there is no `externally_connectable`),
 * and this check keeps it that way if one ever is added. The worker and the offscreen document both use it.
 */
export function fromOwnPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const where = typeof sender.url === "string" ? sender.url : sender.origin;
  if (typeof where !== "string") return false;
  try {
    // Scheme and host, not `origin`: outside Chrome a `chrome-extension:` URL's origin is "null", like every other one.
    const url = new URL(where);
    const own = new URL(chrome.runtime.getURL(""));
    return url.protocol === own.protocol && url.host === own.host;
  } catch {
    return false;
  }
}
