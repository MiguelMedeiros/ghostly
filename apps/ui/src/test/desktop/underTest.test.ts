import { beforeEach, describe, expect, it, vi } from "vitest";

// covers: wallet.instances.first-run

const tauri = vi.hoisted(() => ({ identifier: "tools.ghostly.app", underTest: false, invoke: vi.fn() }));
// The UI suite points every @tauri-apps/api module at one stand-in (packages/browser/src/platform/tauri.ts).
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => tauri.identifier,
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));

import { desktopUnderTest } from "../../desktop/host";
import { defaultWalletsAllowed } from "@ghostly/browser/platform/walletSetupSwitch";

/**
 * The Desktop's first-run wallet switch (#682): the Linux Desktop e2e runs the real bundle id, so `GHOSTLY_E2E=1`
 * (Rust's `under_test`) must count as a test on its own, without `navigator.webdriver`.
 */
describe("the Desktop app under an e2e suite", () => {
  beforeEach(() => {
    tauri.identifier = "tools.ghostly.app";
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "under_test") return tauri.underTest;
      throw new Error(`unexpected ${command}`);
    });
  });

  it("is under test with the e2e bundle id, without asking Rust", async () => {
    tauri.identifier = "tools.ghostly.e2e.a";
    expect(await desktopUnderTest()).toBe(true);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("is under test with the real bundle id when Rust says GHOSTLY_E2E=1, and makes no default wallet", async () => {
    tauri.underTest = true;
    expect(await desktopUnderTest()).toBe(true);
    expect(await defaultWalletsAllowed(desktopUnderTest)()).toBe(false);
  });

  it("makes the default wallets for a person's own app", async () => {
    tauri.underTest = false;
    // A person's app: no automation (the test DOM says otherwise by default).
    vi.spyOn(navigator, "webdriver", "get").mockReturnValue(false);
    expect(await desktopUnderTest()).toBe(false);
    expect(await defaultWalletsAllowed(desktopUnderTest)()).toBe(true);
    vi.restoreAllMocks();
  });

  it("makes none when Rust cannot be asked", async () => {
    tauri.invoke.mockRejectedValue(new Error("no such command"));
    expect(await defaultWalletsAllowed(desktopUnderTest)()).toBe(false);
  });
});
