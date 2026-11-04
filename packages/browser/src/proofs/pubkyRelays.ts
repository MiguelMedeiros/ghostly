/**
 * Pkarr relays a Pubky key's records are read from: Pubky's own, the ones the Pubky SDK uses. A module of its own so
 * that naming them (`fixedHosts.ts`) does not bring `./pubky` into the entry: the web app's install leaves that chunk
 * to its first use (`apps/web/src/sw/policy.ts`).
 */
export const PUBKY_RELAYS: readonly string[] = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];
