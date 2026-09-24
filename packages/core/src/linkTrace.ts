/**
 * Timestamps along a paired link's way back to a live connection, for measuring where the time goes.
 * Silent unless `globalThis.__ghostlyLinkTrace` is set (the e2e measurement sets it): each step is
 * then one `console.debug` line, `[ghostly:link] {"t":…,"me":…,"step":…}`, read back by the test.
 */
export function traceLink(me: string, step: string, detail?: Record<string, unknown>): void {
  if (!(globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace) return;
  console.debug(`[ghostly:link] ${JSON.stringify({ t: Date.now(), me: me.slice(0, 6), step, ...detail })}`);
}
