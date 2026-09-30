import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// covers: files.voice.record

/**
 * On macOS a click on a window that is not the active one only brings it forward: AppKit keeps the click from
 * the page unless the view accepts the first mouse, and Tauri's default is not to. Miguel had to click a voice
 * message's Send twice (#355, then this): whenever the Ghostly window had lost focus while recording (a
 * microphone prompt, another app), the first click only activated it, and WebKit drew the focus ring on the
 * send button instead of sending. Measured with real AppKit events in a WKWebView
 * (`scripts/voice-media/clicker.swift`): locked, window inactive, one click on Send: nothing without
 * acceptFirstMouse, sent with it. No browser test sees this; only the window's configuration does.
 */
const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../../..", path), "utf8"));

interface WindowConfig { label?: string; acceptFirstMouse?: boolean }

describe("the Desktop window", () => {
  it("acts on the first click even when it is not the active window (macOS)", () => {
    const windows = read("apps/desktop/tauri.conf.json").app.windows as WindowConfig[];
    const main = windows.find((window) => (window.label ?? "main") === "main");
    expect(main?.acceptFirstMouse).toBe(true);
    // The other configurations merge over this one: none may turn it back off.
    for (const config of ["apps/desktop/tauri.release.conf.json", "apps/desktop/tauri.e2e.conf.json"]) {
      expect(read(config).app?.windows, config).toBeUndefined();
    }
  });
});
