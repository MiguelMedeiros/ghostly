import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
// covers: chat.ratchet

/**
 * `ghostly-test-no-ratchet` plays an app from before forward secrecy (e2e/web/forward-secrecy.spec.ts). It turns a chat's
 * protection off, so like the suite's fakes (pluginRules.test.ts) a release build ignores it.
 */
const noRatchet = () => (GhostlyNode as unknown as { testNoRatchet(): boolean }).testNoRatchet();

describe("the no-ratchet switch", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("a release build ignores it: not a dev build, no VITE_APPS_TEST", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_APPS_TEST", "");
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "ghostly-test-no-ratchet" ? "1" : null) });
    expect(noRatchet()).toBe(false);
  });

  it("the e2e suite's build reads it: not a dev build, VITE_APPS_TEST set", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_APPS_TEST", "1");
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "ghostly-test-no-ratchet" ? "1" : null) });
    expect(noRatchet()).toBe(true);
  });
});
