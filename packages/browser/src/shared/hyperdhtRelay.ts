/**
 * The HyperDHT relay a browser reaches the HyperDHT through (WISP 103, browser profile). Empty: none, so a
 * browser offers no HyperDHT. Nobody runs a public one for Ghostly yet; this becomes Ghostly's own relay
 * once it is deployed.
 */
export const DEFAULT_HYPERDHT_RELAY = "";

/** Only `wss://`, or `ws://` to this machine (a relay for tests or development). */
export function hyperdhtRelayProblem(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Enter a relay address (wss://…)"; }
  if (parsed.protocol === "wss:") return null;
  if (parsed.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
  return "Use a wss:// relay address";
}
