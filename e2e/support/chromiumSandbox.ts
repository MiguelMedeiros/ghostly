/**
 * Chromium runs with its sandbox on: Playwright turns it off unless `chromiumSandbox: true` is passed. A launch inside a
 * test inherits the worker's `launchOptions`, so a config's `use.launchOptions` and every spec's own `test.use({
 * launchOptions })`, which replaces the config's whole object, carry it. E2E_CHROMIUM_SANDBOX=0 turns it off where the
 * machine has no sandbox to give (a container running as root, a kernel without unprivileged user namespaces).
 */
export const CHROMIUM_SANDBOX = process.env.E2E_CHROMIUM_SANDBOX !== "0";
