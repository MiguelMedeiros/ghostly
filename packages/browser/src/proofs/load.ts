import type { IdentityProofProvider } from "./contract";

type Registry = typeof import("./registry");

/**
 * The identity proof providers, loaded on first need and not with the app: they and their libraries (OpenPGP, the
 * Bitcoin signer, the DID, AT Protocol and OpenID Connect checks) are a large part of the code, and the first screen
 * draws none of it. The engine loads them with the profile's proofs; the UI once it draws something about identities.
 */
let registry: Registry | undefined;
let loading: Promise<Registry> | undefined;
const listeners = new Set<() => void>();

export function loadIdentityProviders(): Promise<Registry> {
  return loading ??= import("./registry").then(m => {
    registry = m;
    for (const listener of listeners) listener();
    return m;
  }, error => { loading = undefined; throw error; });
}

/** Whether they are loaded: before, `loadedIdentityProviders` is empty. */
export const identityProvidersLoaded = (): boolean => !!registry;

/** The providers (built in, from plugins, the test ones when asked for), once loaded; none before. */
export const loadedIdentityProviders = (): readonly IdentityProofProvider[] => registry?.identityProviders() ?? [];

/** Called once they are loaded. Returns the unsubscribe. */
export function onIdentityProvidersLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
