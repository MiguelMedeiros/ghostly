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
 * WebKitGTK before 2.52 holds the page for seconds in an AudioContext.resume() after a suspend() (r11k: a new chat's
 * first sounds froze the Linux app for 5 to 16 s; 2.52 resumes in 3 to 20 ms), so there the sounds' output stays running.
 */
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("whether Desktop suspends the sounds' output between sounds", () => {
  it("keeps it running on WebKitGTK before 2.52, and while the version is not known yet", () => {
    expect(soundsRelease([2, 50, 4], LINUX)).toBe("keep");
    expect(soundsRelease([2, 48, 0], LINUX)).toBe("keep");
    expect(soundsRelease(null, LINUX)).toBe("keep");
  });

  it("suspends it on WebKitGTK 2.52 and later", () => {
    expect(soundsRelease([2, 52, 6], LINUX)).toBe("suspend");
    expect(soundsRelease([2, 54, 0], LINUX)).toBe("suspend");
    expect(soundsRelease([3, 0, 0], LINUX)).toBe("suspend");
  });

  it("suspends it on a Mac, on Windows and on Android, which resume at once", () => {
    expect(soundsRelease(null, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("suspend");
    expect(soundsRelease(null, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("suspend");
    expect(soundsRelease(null, "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toBe("suspend");
  });
});
