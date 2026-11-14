import { afterEach, describe, expect, it, vi } from "vitest";

// covers: invite.clipboard

const invoked = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => { invoked.push([command, args]); }),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { createDesktopHost } from "../../desktop/host";

/*
 * A secret the person copies (an invite, a device's link, a group's link, ecash) goes to the system clipboard through
 * Rust, which marks it to stay out of clipboard history, the cloud clipboard and clipboard managers. The WebView's own
 * copy can mark nothing: on every platform of the app the host copies it, never the page.
 */

const agent = navigator.userAgent;
const setAgent = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });
type Made = { copySecret?(text: string): Promise<void> };

afterEach(() => {
  invoked.length = 0;
  setAgent(agent);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the Desktop host's copy of a secret", () => {
  it.each([
    ["on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"],
    ["on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"],
    ["on Linux", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)"],
    ["in the Android app", "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64; wv) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36"],
  ])("%s is the app's own, marked, and never the page's", async (_where, agent) => {
    setAgent(agent);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const host = createDesktopHost("1.2.0") as unknown as Made;
    expect(host.copySecret).toBeTypeOf("function");
    await host.copySecret!("https://ghostly.tools/#ghostly1abc");
    expect(invoked.filter(([command]) => command === "copy_secret")).toEqual([["copy_secret", { text: "https://ghostly.tools/#ghostly1abc" }]]);
    expect(writeText).not.toHaveBeenCalled();
    writeText.mockRestore();
  });
});
