/**
 * Whether two values hold the same data: primitives by `Object.is`, arrays and plain objects key by key, all the way
 * down. For what comes out of JSON (a message read again from storage, a row the engine sent again): a copy with the
 * same content is the same value, so a list can tell the rows that really changed.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  // Only plain objects compare by content: two different Dates, Maps or class instances are not the same here.
  const proto = Object.getPrototypeOf(a);
  if (Array.isArray(b) || (proto !== Object.prototype && proto !== null) || Object.getPrototypeOf(b) !== proto) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  // A key holding `undefined` is the same as no key: `{ ...(cond && { k }) }` and `{ k: undefined }` both mean none.
  let count = 0;
  for (const key of keys) {
    if (x[key] === undefined) continue;
    count++;
    if (!sameValue(x[key], y[key])) return false;
  }
  for (const key of Object.keys(y)) if (y[key] !== undefined) count--;
  return count === 0;
}
