/**
 * A refused address (a TURN or STUN server, a relay) as a refusal quotes it: without its `user:password@`, `?query` or
 * `#fragment` (a credential or token put in the address), so the CLI and a log keep none of it. The rest is said as
 * given, so the person sees which one was refused. `turn:`/`turns:`/`stun:` is kept even without `//`, any other scheme
 * only before `://` (`user:pw@host` has none).
 *
 * A `?` or `#` before the last `@` leaves no safe cut: that `@` may end a password holding a raw `?` or `#`
 * (`turn:user:pa?ss@host`) or sit in the query (`turn:host?user=me@example.org&credential=…`). Then only the scheme is
 * said, and `…` for the rest.
 */
export function shownAddress(url: string): string {
  const scheme = /^(?:(?:stuns?|turns?):(?:\/\/)?|[a-z][a-z0-9+.-]*:\/\/)/i.exec(url)?.[0] ?? "";
  const rest = url.slice(scheme.length);
  if (/[?#][\s\S]*@/.test(rest)) return `${scheme}…`;
  return scheme + rest.replace(/^[\s\S]*@/, "").replace(/[?#][\s\S]*$/, "");
}
