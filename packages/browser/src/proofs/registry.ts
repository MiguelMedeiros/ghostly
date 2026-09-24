import type { IdentityProofProvider } from "./contract";
import { bitcoin } from "./providers/bitcoin";
import { nostr } from "./providers/nostr";
import { domain } from "./providers/domain";
import { openpgp } from "./providers/openpgp";
import { ssh, sshGithub, sshGitlab } from "./providers/ssh";
import { oidc } from "./providers/oidc";
import { FAKE_IDENTITY_PROVIDERS, testIdentitiesEnabled } from "./testing";
import { registeredIdentityProviders, reserveAdapterIds } from "../plugins/registry";

/**
 * Every identity-proof provider built into Ghostly. Adding one is adding its module under `providers/`
 * and ONE line here; see PROOFS.md. The order is the order of the picker in Profile → Identities. A
 * provider written outside the app registers through `plugins/registry.ts` (the SDK) and comes after.
 */
export const IDENTITY_PROVIDERS: readonly IdentityProofProvider[] = [
  nostr,
  domain,
  openpgp,
  bitcoin,
  ssh, sshGithub, sshGitlab,
  oidc,
];

reserveAdapterIds("identity", IDENTITY_PROVIDERS.map((p) => p.id));

const warned = new Set<string>();
/** The built-in providers, then the ones plugins registered (a built-in's id wins), then the fakes when this browser asked for them (e2e). */
export function identityProviders(): readonly IdentityProofProvider[] {
  const external = registeredIdentityProviders().filter((p) => {
    const taken = IDENTITY_PROVIDERS.some((b) => b.id === p.id);
    if (taken && !warned.has(p.id)) { warned.add(p.id); console.error(`[ghostly] identity provider ${p.id} from a plugin is ignored: a built-in has that id`); }
    return !taken;
  });
  return [...IDENTITY_PROVIDERS, ...external, ...(testIdentitiesEnabled() ? FAKE_IDENTITY_PROVIDERS : [])];
}

export function identityProvider(id: string, providers = identityProviders()): IdentityProofProvider | undefined {
  return providers.find(p => p.id === id);
}
