/**
 * Tests only: `localStorage["ghostly-test-wallet-setup"]` = "on" makes a new profile's default Mainnet wallets even in
 * an automated browser (a spec that stubs every Mainnet server), "off" never.
 */
export const WALLET_SETUP_TEST_KEY = "ghostly-test-wallet-setup";

/**
 * Whether this app makes a new profile's default Mainnet wallets (`NodeOptions.defaultWallets`). Never under test: an
 * automated browser (`navigator.webdriver`: Playwright, WebDriver) or what the host knows to be a test build
 * (`underTest`), so no test reaches a Mainnet server by accident. A test switch in the storage wins over both. Read once,
 * when the peer starts; a check that fails counts as a test.
 */
export function defaultWalletsAllowed(underTest: () => boolean | Promise<boolean> = () => false): () => Promise<boolean> {
  return async () => {
    let asked: string | null = null;
    try { asked = localStorage.getItem(WALLET_SETUP_TEST_KEY); } catch { /* no storage here */ }
    if (asked === "off") return false;
    if (asked === "on") return true;
    if (typeof navigator !== "undefined" && navigator.webdriver === true) return false;
    try { return !(await underTest()); } catch { return false; }
  };
}
