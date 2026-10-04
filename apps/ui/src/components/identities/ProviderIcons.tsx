import { providerForIssuer } from "@ghostly/browser/proofs/oidc/providers";
import { PROVIDER_ICONS } from "./providerMarks";

/** The marks themselves are in providerMarks.tsx (no engine import, so the website can copy it). */
export { PROVIDER_ICONS, type ProviderIcon } from "./providerMarks";

/** The provider's icon; for an OpenID Connect proof whose subject names a known provider, that provider's. */
export function providerIcon(provider: string, subject?: string) {
  const oidc = provider === "oidc" && subject ? providerForIssuer(subject)?.id : undefined;
  const key = oidc ? `oidc:${oidc}` : provider;
  return PROVIDER_ICONS[key] ? { key, ...PROVIDER_ICONS[key] } : undefined;
}
