/**
 * Reloads the app, but only into a page the server answers for: a reload with no connection leaves the browser's own
 * error page, and no app at all. Settles without reloading while the server is out of reach.
 *
 * The way out once a part of the app (a file of its own) failed to load: Chromium keeps a failed import for as long as
 * the page lives, so asking for the file again there cannot bring it. Firefox and Safari ask the server again.
 */
export async function reloadIfServed(): Promise<void> {
  try {
    if ((await fetch(location.pathname, { method: "HEAD", cache: "no-store" })).ok) location.reload();
  } catch { /* no connection yet */ }
}
