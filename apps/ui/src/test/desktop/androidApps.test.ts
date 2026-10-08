import { afterEach, describe, expect, it, vi } from "vitest";

// covers: apps.desktop-sandbox

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { createDesktopHost } from "../../desktop/host";

/*
 * Mini-apps (WISP 1200) are not in the Android app yet: its host frames none and tells the engine so, even in the e2e
 * suite's build (VITE_APPS_TEST, which the Android e2e builds with) and once the feature is on in every build.
 */

const agent = navigator.userAgent;
const setAgent = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });
type Made = { appRunner?: string; appNetRunner?: string; appRunnerServed?: boolean; node: { apps?: boolean; appFetch?: unknown } };
const made = () => createDesktopHost("1.2.0") as unknown as Made;

afterEach(() => {
  vi.unstubAllEnvs();
  setAgent(agent);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the Desktop host's mini-apps", () => {
  it("on Desktop, in the e2e suite's build: its runner, and the engine told apps are on", () => {
    vi.stubEnv("VITE_APPS_TEST", "1");
    setAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const host = made();
    expect([host.appRunner, host.appNetRunner, host.appRunnerServed]).toEqual(["ghostly-app://localhost/", "ghostly-app://localhost/", true]);
    expect(host.node.apps).toBe(true);
  });

  it("in the Android app, even in the e2e suite's build: no runner, and the engine told apps are off", () => {
    vi.stubEnv("VITE_APPS_TEST", "1");
    setAgent("Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64; wv) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const host = made();
    expect(host.appRunner).toBeUndefined();
    expect(host.appNetRunner).toBeUndefined();
    expect(host.appRunnerServed).toBeUndefined();
    // Off, not left out: the engine's default would follow APPS_ENABLED.
    expect(host.node.apps).toBe(false);
    expect(host.node).not.toHaveProperty("appFetch");
  });
});
