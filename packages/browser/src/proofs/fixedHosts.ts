import { DEFAULT_RELAYS } from "@ghostly/core";
import { plcDirectory } from "./atproto/resolve";
import { DOH_RESOLVERS } from "./domain";
import { oidcProviders } from "./oidc/providers";
import { PUBKY_RELAYS } from "./pubkyRelays";
import { SSH_FORGE_HOST } from "./sshForges";

/**
 * The hosts a contact's proof may be checked on while "Hide my IP from contacts" is on: the ones this app names
 * (DNS-over-HTTPS resolvers, the PLC directory, Pkarr relays, the OpenID providers' keys, the forges' APIs), never one
 * the contact's evidence names (a did:web or a domain's own web server, an AT Protocol server, a Pubky homeserver),
 * which would see this device's IP address.
 */
export function fixedIdentityHosts(): ReadonlySet<string> {
  const urls = [...DOH_RESOLVERS.map(r => r.url), plcDirectory(), ...PUBKY_RELAYS, ...DEFAULT_RELAYS, ...oidcProviders().map(p => p.jwksUri)];
  return new Set([...urls.map(u => new URL(u).host), ...Object.values(SSH_FORGE_HOST)]);
}
