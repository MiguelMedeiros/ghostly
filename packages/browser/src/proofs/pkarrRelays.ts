import { DEFAULT_RELAYS, normalizeRelayUrl } from "@ghostly/core";

/**
 * The profile's Pkarr relays (Network settings), which a did:dht proof is read from, as every other Pkarr read: a
 * person who replaced the list is never read from the defaults. The UI and the engine each set where to read it. Here,
 * not in the provider, so setting it does not load the providers.
 */
let source: () => readonly string[] | undefined = () => undefined;
export function setPkarrRelaySource(read: () => readonly string[] | undefined): void { source = read; }
export function pkarrRelays(): string[] {
  const relays = source();
  return relays?.length ? [...relays] : [...DEFAULT_RELAYS];
}

/** Whether `url` is under one of the profile's Pkarr relays (`<relay>/…`). */
export function isOwnPkarrRelayUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  return pkarrRelays().map(normalizeRelayUrl).some(relay => relay !== null && url.href.startsWith(`${relay}/`));
}
