import { describe, expect, it, vi } from "vitest";

// covers: app.attention.sounds

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));

import { soundsRelease } from "../../desktop/host";

/*
 * WebKitGTK holds the page for seconds in an AudioContext.resume() after a suspend() (r11k: a new chat's first sound
 * froze the Linux app for 5 to 10 s), so the Linux Desktop closes its sounds' output between sounds instead.
 */
describe("how Desktop lets go of the sounds' output", () => {
  it("closes it on Linux (WebKitGTK)", () => {
    expect(soundsRelease("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("close");
    expect(soundsRelease("Mozilla/5.0 (Wayland; Linux aarch64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("close");
  });

  it("suspends it on a Mac, on Windows and on Android, which resume at once", () => {
    expect(soundsRelease("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("suspend");
    expect(soundsRelease("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("suspend");
    expect(soundsRelease("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toBe("suspend");
  });
});
