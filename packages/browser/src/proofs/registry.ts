import type { IdentityProofProvider } from "./contract";
import { nostr } from "./providers/nostr";
import { FAKE_IDENTITY_PROVIDERS, testIdentitiesEnabled } from "./testing";

/**
 * Every identity-proof provider Ghostly knows. Adding one is adding its module under `providers/` and
 * ONE line here; see PROOFS.md. The order is the order of the picker in Profile → Identities.
 */
export const IDENTITY_PROVIDERS: readonly IdentityProofProvider[] = [
  nostr,
];

/** The registered providers, plus the fakes when this browser asked for them (e2e). */
export function identityProviders(): readonly IdentityProofProvider[] {
  return testIdentitiesEnabled() ? [...IDENTITY_PROVIDERS, ...FAKE_IDENTITY_PROVIDERS] : IDENTITY_PROVIDERS;
}

export function identityProvider(id: string, providers = identityProviders()): IdentityProofProvider | undefined {
  return providers.find(p => p.id === id);
}
