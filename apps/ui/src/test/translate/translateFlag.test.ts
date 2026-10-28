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
