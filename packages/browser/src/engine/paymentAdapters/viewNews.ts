/**
 * Whether a wallet's view reads otherwise after a poll: only then is the poll news to the engine, which makes the whole
 * wallet view again for it. Compared as written, not by reference: a poll builds its history and expiry anew each time.
 * A view that cannot be written out is news.
 */
export function viewNews(before: unknown, after: unknown): boolean {
  try { return JSON.stringify(before) !== JSON.stringify(after); } catch { return true; }
}
