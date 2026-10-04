import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { readDesktopStorage, storageBreakdown } from "../../lib/desktopStorage";

// covers: settings.storage-used

/**
 * "Storage used" on the Desktop (lib/desktopStorage): the WebView's estimate, the app's settings, and the profile's
 * files on disk as Rust counts them (`file_bytes_usage`), added up; the parts behind the ⓘ.
 */

afterEach(() => {
  delete (navigator as { storage?: unknown }).storage;
  resetFileBytes();
});

describe("the breakdown", () => {
  it("adds every part it could measure, staged copies only when there are some", () => {
    expect(storageBreakdown({ app: 2000, local: 100, files: { files: 5000, count: 3, staged: 700 } })).toEqual({
      total: 7800,
      parts: [{ key: "app", bytes: 2000 }, { key: "local", bytes: 100 }, { key: "files", bytes: 5000, count: 3 }, { key: "staged", bytes: 700 }],
    });
    expect(storageBreakdown({ app: 2000, local: 100, files: { files: 0, count: 0, staged: 0 } }).parts.map((p) => p.key)).toEqual(["app", "local", "files"]);
  });

  it("leaves out what nobody could measure, and still counts the settings", () => {
    expect(storageBreakdown({ app: null, local: 100, files: null })).toEqual({ total: 100, parts: [{ key: "local", bytes: 100 }] });
  });
});

describe("reading it", () => {
  it("asks the WebView and Rust", async () => {
    Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: vi.fn(async () => ({ usage: 4096, quota: 1e9 })) } });
    const usage = vi.fn(async () => ({ files: 10, count: 1, staged: 0 }));
    registerFileBytes("native", async () => ({ kind: "native", usage }) as unknown as FileBytes, true);
    expect(await readDesktopStorage(50)).toEqual({ app: 4096, local: 50, files: { files: 10, count: 1, staged: 0 } });
  });

  it("goes on without a part that fails or does not exist", async () => {
    Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: vi.fn(async () => { throw new Error("no"); }) } });
    registerFileBytes("native", async () => ({ kind: "native", usage: async () => { throw new Error("No such space"); } }) as unknown as FileBytes, true);
    expect(await readDesktopStorage(50)).toEqual({ app: null, local: 50, files: null });
    resetFileBytes();
    Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
    expect(await readDesktopStorage(0)).toEqual({ app: null, local: 0, files: null });
  });
});
