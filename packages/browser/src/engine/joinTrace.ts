/**
 * Timestamps along a join through a group's link, for measuring where the time goes. Silent unless
 * the page sets `globalThis.__ghostlyJoinTrace` (the e2e measurement does): each step is then one
 * `console.debug` line, `[ghostly:join] {"t":…,"g":…,"step":…}`, read back by the test. A host may also
 * install a sink (the CLI writes the lines beside its link trace), which gets every line whether or not
 * the global is set.
 */
type JoinTraceSink = (line: string) => void;
let sink: JoinTraceSink | null = null;

/** Where the lines go besides the console; `null` removes it. */
export function setJoinTraceSink(next: JoinTraceSink | null): void {
  sink = next;
}

export function traceJoin(group: string, step: string, detail?: Record<string, unknown>): void {
  const console_ = (globalThis as { __ghostlyJoinTrace?: boolean }).__ghostlyJoinTrace;
  if (!console_ && !sink) return;
  const line = JSON.stringify({ t: Date.now(), g: group, step, ...detail });
  if (console_) console.debug(`[ghostly:join] ${line}`);
  try { sink?.(line); } catch { /* a sink that fails must not fail the join */ }
}
