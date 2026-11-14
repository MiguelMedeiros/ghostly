import { DEFAULT_RELAYS } from "@ghostly/core";

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
