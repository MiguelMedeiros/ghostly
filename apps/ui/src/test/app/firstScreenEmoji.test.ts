import { describe, expect, it, vi } from "vitest";

/**
 * The first screen does not load emoji-mart's emoji data set (about 420 KiB): only the emoji panels use it, and it is
 * loaded the first time one shows (chat/emojiPanelLoad.test.tsx).
 */
const { evaluated } = vi.hoisted(() => ({ evaluated: [] as string[] }));
vi.mock("@emoji-mart/data", () => { evaluated.push("@emoji-mart/data"); return { default: { categories: [], emojis: {} } }; });

describe("the first screen", () => {
  it("does not load the emoji data set with the app", async () => {
    vi.resetModules();
    await import("../../Root");
    expect(evaluated).toEqual([]);
  });
});
