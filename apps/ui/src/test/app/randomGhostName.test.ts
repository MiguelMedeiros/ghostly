import { afterEach, describe, expect, it, vi } from "vitest";

// covers: settings.nickname

import { getRandomGhostName } from "../../lib/storage";

/*
 * The random default name draws again when the draw falls past the largest multiple of the list's length, so every
 * name is equally likely (a plain modulo favours the first names).
 */
describe("getRandomGhostName", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws again past the last full multiple of the list length", () => {
    const draws = [2 ** 32 - 1, 0];
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = draws.shift()!;
      return array;
    });
    expect(getRandomGhostName()).toBe("Casper");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
