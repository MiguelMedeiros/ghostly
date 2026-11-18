/*
 * When a peer's first load is worth one more: the rule `openApp` (support/fixtures.ts) loads the page again by.
 *
 * On a Linux machine that also runs docker (the nightly e2e round), another e2e bringing its containers up or down
 * adds and removes veth and bridge interfaces, and Chromium treats that as a network change: it aborts the requests
 * in flight with `net::ERR_NETWORK_CHANGED`. When one of them was the app's main script, the page never drew and the
 * boot guard (apps/web/public/boot-guard.js) said "Ghostly could not start" with `script did not load: main-….js`.
 * Only that is retried: any other failure, a boot error the app throws included, still fails the test at once.
 * No browser here, so tools/scripts/test/e2eBootReload.test.ts runs it as it is.
 */

/** What Chromium says when it aborted a request because the machine's network changed under it. */
export const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

/** How many times a first load is done again before the test fails as it would have. */
export const MAX_BOOT_RELOADS = 2;

/** A boot guard error that says a file did not arrive, as a dropped request leaves it: not one the app threw. */
const LOAD_FAILURE = /did not load|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/**
 * Why the page is to be loaded again, or null to let the test fail as it is.
 *
 * `failures` are the `errorText`s of the requests that failed while the page loaded, before the app drew (a
 * `requestfailed` event's `failure()?.errorText`); `bootError` is what the boot guard's error alert says, null when
 * it did not show one (the app did not draw in time, or the navigation itself failed); `reloads` is how many times
 * this load has already been done again.
 */
export function shouldReloadAfterBoot(failures: readonly string[], bootError: string | null, reloads = 0): string | null {
  if (reloads >= MAX_BOOT_RELOADS) return null;
  if (!failures.includes(NETWORK_CHANGED)) return null;
  if (bootError !== null && !LOAD_FAILURE.test(bootError)) return null;
  return NETWORK_CHANGED;
}
