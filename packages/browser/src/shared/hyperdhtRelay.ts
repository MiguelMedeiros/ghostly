import { relayUrl, relayUrlTooLong } from "@ghostly/core";

/**
 * The HyperDHT relay a browser reaches the HyperDHT through (WISP 103, browser profile). Empty: none, so a
 * browser offers no HyperDHT. Nobody runs a public one for Ghostly yet; this becomes Ghostly's own relay
 * once it is deployed.
 */
export const DEFAULT_HYPERDHT_RELAY = "";

/**
 * Only `wss://`, or `ws://` to this machine (a relay for tests or development). Nothing but the server's address, as
 * an Iroh relay (irohWeb.ts `irohRelayProblem`): the endpoint names this URL as its descriptor's relay, which every
 * contact is told, so a login, a password, a query or a fragment in it would go to them all.
 */
export function hyperdhtRelayProblem(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Enter a relay address (wss://…)"; }
  if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) return "Use a wss:// relay address";
  if (parsed.username || parsed.password || /[?#]/.test(url)) return `Not a relay address: ${url}`;
  // Nor one a contact would drop with the whole descriptor (`relayUrl`: a space in it, past 126 characters, a capital in
  // `localhost`), leaving the relay unused for reaching this browser without a word. One refused for its length alone
  // is a relay address all the same: what to do is said instead.
  const named = hyperdhtRelayUrl(url);
  if (url.length > 256 || !relayUrl(named)) return relayUrlTooLong(named) ? `Use a shorter relay address: ${url}` : `Not a relay address: ${url}`;
  return null;
}

/**
 * The relay as the endpoint names it to contacts: its scheme in lower case, as `relayUrl` reads it (`WSS://relay.example`
 * pasted is wss://relay.example), the rest as typed.
 */
export const hyperdhtRelayUrl = (url: string): string => url.replace(/^[a-z]+:/i, scheme => scheme.toLowerCase());
