import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translateEnabled } from "../../lib/translateFlag";

describe("auto-translation's build switch", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is off unless the build was made with VITE_TRANSLATE=1", () => {
    expect(translateEnabled()).toBe(false);
    for (const value of ["", "0", "true", "yes"]) {
      vi.stubEnv("VITE_TRANSLATE", value);
      expect(translateEnabled(), value).toBe(false);
    }
    vi.stubEnv("VITE_TRANSLATE", "1");
    expect(translateEnabled()).toBe(true);
  });

  it("is off in the Android app even in a build made with it: Desktop only in the first version", () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    const agent = navigator.userAgent;
    const as = (userAgent: string, tauri: boolean) => {
      Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
      if (tauri) Object.assign(window, { __TAURI_INTERNALS__: {} });
      else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    };
    try {
      as("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36", true);
      expect(translateEnabled()).toBe(false);
      as("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)", true);
      expect(translateEnabled()).toBe(true);
      as("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0", true);
      expect(translateEnabled()).toBe(true);
    } finally {
      as(agent, false);
    }
  });

  it("is not the e2e suite's mini-app switch", () => {
    vi.stubEnv("VITE_APPS_TEST", "1");
    expect(translateEnabled()).toBe(false);
  });

  it("is read from the build (import.meta.env) only, never from storage or the address", () => {
    const text = readFileSync(join(import.meta.dirname, "../../lib/translateFlag.ts"), "utf8");
    const code = text.split("\n").filter((line) => !/^\s*(\/\/|\/\*\*|\*)/.test(line)).join("\n");
    expect(code).toMatch(/import\.meta\.env\??\.VITE_TRANSLATE === "1"/);
    expect(code).not.toMatch(/localStorage|sessionStorage|location|searchParams|indexedDB/);
  });
});
