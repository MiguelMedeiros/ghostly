// Imports nothing: the extension's service worker takes RELEASES_URL from here, and what settings.ts imports (every
// English string, the profiles and the device store) would load with it each time Chrome wakes the worker.

export const APP_WEBSITE = "https://github.com/MiguelMedeiros/ghostly";
/** Where every client sends someone who installs a new version by hand. */
export const RELEASES_URL = `${APP_WEBSITE}/releases/latest`;
