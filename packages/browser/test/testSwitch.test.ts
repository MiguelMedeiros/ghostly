import { afterEach, describe, expect, it, vi } from "vitest";
import { testSwitch } from "../src/shared/features";

// covers: chat.edit.wire, chat.reactions.wire, chat.paired.pair-timing, delivery.hold.expiry, profiles.peek

/** The suite's storage switches (`ghostly-test-*`): read in a dev or e2e build, never in a release one. */
describe("testSwitch", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const stored = (values: Record<string, string>) => vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] ?? null });

  it("a release build reads none: not a dev build, no VITE_APPS_TEST", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_APPS_TEST", "");
    stored({ "ghostly-test-no-edit": "1", "ghostly-test-hold-ttl": "5000" });
    expect(testSwitch("ghostly-test-no-edit")).toBeNull();
    expect(testSwitch("ghostly-test-hold-ttl")).toBeNull();
  });

  it("the e2e suite's build reads them: not a dev build, VITE_APPS_TEST set", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_APPS_TEST", "1");
    stored({ "ghostly-test-no-edit": "1" });
    expect(testSwitch("ghostly-test-no-edit")).toBe("1");
    expect(testSwitch("ghostly-test-pace")).toBeNull();
  });

  it("a dev build reads them, and storage that throws reads as unset", () => {
    vi.stubEnv("DEV", true);
    stored({ "ghostly-test-iroh": "off" });
    expect(testSwitch("ghostly-test-iroh")).toBe("off");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError: storage is blocked"); } });
    expect(testSwitch("ghostly-test-iroh")).toBeNull();
  });
});
