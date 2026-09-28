/**
 * The push relay a browser hands wake-ups to when it may not post to a push service itself (WISP 401 § Wake-up
 * push). None by default: Ghostly runs none, and one is only ever the person's choice.
 */

/** Only `https://`, or `http://` to this machine (a relay for tests or development). No credentials in it. */
export function pushRelayProblem(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Enter a relay address (https://…)"; }
  if (parsed.username || parsed.password) return "Leave the user and password out of the address";
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
  return "Use an https:// relay address";
}
