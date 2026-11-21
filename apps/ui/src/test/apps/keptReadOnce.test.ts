import { describe, expect, it } from "vitest";
import { kept } from "../../lib/apps/kept";

// covers: apps.page

type Store = { key: string; fetchedAt?: number; apps: { ref: string }[] };

/** What the Apps page compares of a store, counting each store it is asked for. */
const compared: Store[] = [];
const withoutReadTime = (store: Store) => { compared.push(store); return { ...store, fetchedAt: store.fetchedAt !== undefined }; };
const storeKey = (store: Store) => store.key;
const read = (at: number, refs = ["a", "b"]): Store[] =>
  ["one", "two"].map((key) => ({ key, fetchedAt: at, apps: refs.map((ref) => ({ ref })) }));

/**
 * Each store reload compares the stores read with the ones held: the held ones were read (and turned into JSON) by the
 * reload before, so only the new ones are turned into JSON again, not every held store's listings each time.
 */
describe("kept reads each item once", () => {
  it("a reload that changed nothing turns only the stores read into JSON, not the held ones again", () => {
    let held = kept(null, read(1), storeKey, withoutReadTime);
    held = kept(held, read(2), storeKey, withoutReadTime);
    compared.length = 0;
    const next = read(3);
    expect(kept(held, next, storeKey, withoutReadTime)).toBe(held);
    expect(compared).toEqual(next);
  });

  it("a store whose listings changed is drawn anew, and the reload after compares it by what was read", () => {
    const first = kept(null, read(1), storeKey, withoutReadTime);
    const changed = read(2, ["a", "b", "c"]);
    const held = kept(first, changed, storeKey, withoutReadTime);
    expect(held).toEqual(changed);
    expect(held[0]).toBe(changed[0]);
    compared.length = 0;
    const next = read(3, ["a", "b", "c"]);
    expect(kept(held, next, storeKey, withoutReadTime)).toBe(held);
    expect(compared).toEqual(next);
  });

  it("items that are not objects are still compared by value", () => {
    expect(kept(["a", "b"], ["a", "b"], (item) => item)).toEqual(["a", "b"]);
    const held = ["a", "b"];
    expect(kept(held, ["a", "b"], (item) => item)).toBe(held);
  });
});
