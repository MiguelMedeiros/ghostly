/**
 * Timestamps along a paired link's way to a live connection, for measuring where the time goes.
 * Silent unless `globalThis.__ghostlyLinkTrace` is set (the e2e measurements set it): each step is
 * then one `console.debug` line, `[ghostly:link] {"t":…,"me":…,"step":…}`, read back by the test.
 * A host may also install a sink (the desktop app writes the lines to its log file), which gets every
 * line whether or not the global is set.
 */
type LinkTraceSink = (line: string) => void;
let sink: LinkTraceSink | null = null;

/** Where the lines go besides the console; `null` removes it. */
export function setLinkTraceSink(next: LinkTraceSink | null): void {
  sink = next;
}

export function traceLink(me: string, step: string, detail?: Record<string, unknown>): void {
  const console_ = (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace;
  if (!console_ && !sink) return;
  const line = JSON.stringify({ t: Date.now(), me: me.slice(0, 6), step, ...detail });
  if (console_) console.debug(`[ghostly:link] ${line}`);
  try { sink?.(line); } catch { /* a sink that fails must not fail the link */ }
}
