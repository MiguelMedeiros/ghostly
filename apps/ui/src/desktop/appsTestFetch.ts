/**
 * The e2e build's way to read a test store on Desktop (WISP 1200 § Stores), where WebDriver cannot route a request as
 * Playwright does on the web (e2e/support/appStore.ts). Only a build made with VITE_APPS_TEST=1 uses it
 * (desktop/host.ts): a release build has none of it.
 *
 * A spec sets `window.__ghostlyAppsStore` to its local server (`http://127.0.0.1:<port>`); a read of an allowed host
 * then goes there, path and all. The engine checked the URL against its hosts before this runs, and the answer keeps
 * no URL of its own, so nothing reads it as a redirect. Without the setting, reads go where they say.
 */
export function appsTestFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const base = (globalThis as { __ghostlyAppsStore?: unknown }).__ghostlyAppsStore;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /^https:\/\/(raw\.githubusercontent\.com|cdn\.jsdelivr\.net)(\/.*)$/.exec(url);
    if (typeof base !== "string" || !match) return fetcher(input, init);
    const response = await fetcher(`${base}/${match[1]}${match[2]}`, { ...init, redirect: "error" });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
