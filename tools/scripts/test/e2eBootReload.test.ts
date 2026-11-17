import { describe, expect, it } from "vitest";
import { MAX_BOOT_RELOADS, NETWORK_CHANGED, shouldReloadAfterBoot } from "../../../e2e/support/bootReload";

/*
 * The rule `openApp` (e2e/support/fixtures.ts) loads a peer's page again by. In the nightly e2e round another e2e's
 * docker containers came and went on the same Linux machine; Chromium took that for a network change and aborted the
 * app's main script with `net::ERR_NETWORK_CHANGED`, and the boot guard said "Ghostly could not start". Only that
 * load is done again; a boot error the app throws, and any other failed request, still fail the test at once.
 */

const MAIN_MISSING = "Ghostly could not start\nscript did not load: main-mGcPMij9.js\nChrome 141";

describe("shouldReloadAfterBoot", () => {
  it("reloads when the main script was dropped by a network change and the boot guard said so", () => {
    expect(shouldReloadAfterBoot([NETWORK_CHANGED, NETWORK_CHANGED], MAIN_MISSING)).toBe(NETWORK_CHANGED);
  });

  it("reloads when a network change broke the load before the boot guard spoke (the navigation itself, or no draw in time)", () => {
    expect(shouldReloadAfterBoot(["net::ERR_BLOCKED_BY_CLIENT", NETWORK_CHANGED], null)).toBe(NETWORK_CHANGED);
  });

  it("reloads for a lazy chunk the network change dropped", () => {
    expect(shouldReloadAfterBoot([NETWORK_CHANGED], "TypeError: Failed to fetch dynamically imported module: http://localhost:4173/assets/x.js")).toBe(NETWORK_CHANGED);
  });

  it("does not reload a boot error the app threw, even with a network change in the same load", () => {
    expect(shouldReloadAfterBoot([NETWORK_CHANGED], "TypeError: navigator.locks is undefined (main-abc.js:1:200)")).toBeNull();
  });

  it("does not reload without a network change: a script that did not load for another reason fails at once", () => {
    expect(shouldReloadAfterBoot([], MAIN_MISSING)).toBeNull();
    expect(shouldReloadAfterBoot(["net::ERR_CONNECTION_REFUSED"], MAIN_MISSING)).toBeNull();
    expect(shouldReloadAfterBoot(["net::ERR_ABORTED", "net::ERR_BLOCKED_BY_CLIENT"], null)).toBeNull();
    expect(shouldReloadAfterBoot(["net::ERR_NETWORK_CHANGED_SOMEHOW"], null)).toBeNull();
  });

  it(`reloads at most ${MAX_BOOT_RELOADS} times`, () => {
    expect(MAX_BOOT_RELOADS).toBe(2);
    expect(shouldReloadAfterBoot([NETWORK_CHANGED], MAIN_MISSING, 0)).toBe(NETWORK_CHANGED);
    expect(shouldReloadAfterBoot([NETWORK_CHANGED], MAIN_MISSING, 1)).toBe(NETWORK_CHANGED);
    expect(shouldReloadAfterBoot([NETWORK_CHANGED], MAIN_MISSING, 2)).toBeNull();
  });
});
