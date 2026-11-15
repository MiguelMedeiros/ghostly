/**
 * `next` with each item that reads as before (the same `key`, the same JSON) kept as the object held, and the list held
 * when every item is. A list read again that changed nothing then draws nothing again, and one item that changed draws
 * only itself: the installed apps (each Apps page visit, in every tab, reads them again) and the stores the update check
 * and each Refresh read again.
 */
export function kept<T>(held: readonly T[] | null, next: readonly T[], key: (item: T) => string): readonly T[] {
  if (!held) return next;
  const before = new Map(held.map((item) => [key(item), item]));
  let same = held.length === next.length;
  const out = next.map((item, i) => {
    const old = before.get(key(item));
    const view = old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
    if (view !== held[i]) same = false;
    return view;
  });
  return same ? held : out;
}
