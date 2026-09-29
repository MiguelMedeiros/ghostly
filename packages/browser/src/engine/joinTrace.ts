/**
 * Timestamps along a join through a group's link, for measuring where the time goes. Silent unless
 * the page sets `globalThis.__ghostlyJoinTrace` (the e2e measurement does): each step is then one
 * `console.debug` line, `[ghostly:join] {"t":…,"g":…,"step":…}`, read back by the test.
 */
export function traceJoin(group: string, step: string, detail?: Record<string, unknown>): void {
  if (!(globalThis as { __ghostlyJoinTrace?: boolean }).__ghostlyJoinTrace) return;
  console.debug(`[ghostly:join] ${JSON.stringify({ t: Date.now(), g: group, step, ...detail })}`);
}
