import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IDENTITY_PROVIDERS } from '../src/proofs/registry';
import { OIDC_PROVIDERS } from '../src/proofs/oidc/providers';
import { PROVIDER_ICONS } from '../../../src/components/identities/ProviderIcons';
// covers: proofs.picker

/**
 * Profile → Identities shows one mark per provider (src/components/identities/ProviderIcons.tsx).
 * A provider without one would silently fall back to the generic key, so every registered
 * provider, and every OpenID Connect provider offered inside "Account at a provider", has its own.
 */
describe('identity provider icons', () => {
  const renders = (key: string) => {
    const icon = PROVIDER_ICONS[key];
    expect(icon, `no icon for "${key}"`).toBeDefined();
    expect(icon.tile).toMatch(/\bbg-/);
    const markup = renderToStaticMarkup(icon.mark(24));
    expect(markup).toMatch(/^<svg /);
    expect(markup).toContain('width="24"');
    expect(markup).not.toMatch(/href=|<image|url\(/); // inline: nothing fetched
  };

  it.each(IDENTITY_PROVIDERS.map(p => p.id))('provider "%s" has its own mark', renders);
  it.each(Object.keys(OIDC_PROVIDERS))('OpenID Connect provider "%s" has its own mark', id => renders(`oidc:${id}`));

  it('has no mark for a provider nobody registered', () => {
    expect(PROVIDER_ICONS['fake-key']).toBeUndefined();
  });
});
