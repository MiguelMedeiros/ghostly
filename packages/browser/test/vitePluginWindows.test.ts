import { describe, expect, it, vi } from "vitest";

/**
 * The Desktop app for Windows is built on Windows (release.yml), where `node:path` writes `\` and Vite hands every
 * resolved id with `/` (its `normalizePath`). A swap list keyed by `node:path` paths then matches nothing: the Windows
 * app shipped Desktop's own chat (the Pkarr loop of `apps/ui/src/hooks/useChat.ts`) instead of the shared peer's, and
 * its texts never reached a paired contact (ghostly#1864). This builds the plugin as Windows would.
 */
vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...path.win32, default: path.win32 };
});
vi.mock("node:url", async () => {
  const url = await vi.importActual<typeof import("node:url")>("node:url");
  return { ...url, fileURLToPath: () => "C:\\repo\\packages\\browser\\" };
});

const SWAPS = [
  ["apps/ui/src/hooks/useChat.ts", "packages/browser/src/platform/useChat.ts"],
  ["apps/ui/src/hooks/useBackgroundPoller.ts", "packages/browser/src/platform/useBackgroundPoller.ts"],
  ["apps/ui/src/lib/pkarr.ts", "packages/browser/src/platform/pkarr.ts"],
  ["apps/ui/src/lib/crypto.ts", "packages/browser/src/platform/crypto.ts"],
  ["apps/ui/src/lib/platform.ts", "packages/browser/src/platform/services.ts"],
  ["apps/ui/src/lib/updates.ts", "packages/browser/src/platform/updates.ts"],
] as const;

type ResolveId = (this: { resolve: (source: string) => Promise<{ id: string }> }, source: string, importer: string | undefined, options: object) => Promise<string | null>;

describe("the platform swap, built on Windows", () => {
  it("replaces each Desktop module by the id Vite gives it", async () => {
    const { ghostlyPlatformModules } = await import("../vite-plugin");
    const resolveId = ghostlyPlatformModules().resolveId as unknown as ResolveId;
    for (const [desktop, platform] of SWAPS) {
      const vite = { resolve: async () => ({ id: `C:/repo/${desktop}` }) };
      expect(await resolveId.call(vite, "./module", "C:/repo/apps/ui/src/pages/Chat.tsx", {}), desktop).toBe(`C:/repo/${platform}`);
    }
  });

  it("leaves the stand-ins' own imports alone", async () => {
    const { ghostlyPlatformModules } = await import("../vite-plugin");
    const resolveId = ghostlyPlatformModules().resolveId as unknown as ResolveId;
    // platform/useChat.ts reads Desktop's storage and types: the stand-in never stands in for itself.
    const vite = { resolve: async () => ({ id: "C:/repo/apps/ui/src/hooks/useChat.ts" }) };
    expect(await resolveId.call(vite, "../../../../apps/ui/src/hooks/useChat", "C:/repo/packages/browser/src/platform/useChat.ts", {})).toBeNull();
  });
});
