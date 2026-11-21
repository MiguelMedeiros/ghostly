const whole = (item: unknown) => item;

/**
 * Each item's JSON, by the `same` it was read with: the list held was read as `next` the last time (or compared once),
 * so a reload turns into JSON only what it read, not the held list again (4 stores of 4,096 listings: 34 ms a reload).
 * The items are never changed in place: a list read again is new objects.
 */
const read = new WeakMap<(item: never) => unknown, WeakMap<object, string>>();

function jsonOf<T>(item: T, same: (item: T) => unknown): string {
  if (typeof item !== "object" || item === null) return JSON.stringify(same(item));
  let byItem = read.get(same);
  if (!byItem) read.set(same, byItem = new WeakMap());
  let json = byItem.get(item);
  if (json === undefined) byItem.set(item, json = JSON.stringify(same(item)));
  return json;
}

/**
 * `next` with each item that reads as before (the same `key`, the same JSON) kept as the object held, and the list held
 * when every item is. A list read again that changed nothing then draws nothing again, and one item that changed draws
 * only itself: the installed apps (each Apps page visit, in every tab, reads them again) and the stores the update check
 * and each Refresh read again. `same` gives what is compared of an item (the whole item by default), to leave out a
 * field nothing draws.
 */
export function kept<T>(held: readonly T[] | null, next: readonly T[], key: (item: T) => string,
  same: (item: T) => unknown = whole): readonly T[] {
  if (!held) return next;
  const before = new Map(held.map((item) => [key(item), item]));
  let unchanged = held.length === next.length;
  const out = next.map((item, i) => {
    const old = before.get(key(item));
    const view = old && jsonOf(old, same) === jsonOf(item, same) ? old : item;
    if (view !== held[i]) unchanged = false;
    return view;
  });
  return unchanged ? held : out;
}
