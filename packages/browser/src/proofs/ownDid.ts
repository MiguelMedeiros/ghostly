/**
 * The profile's own Ghostly did:dht, which the DID provider refuses as an external identity. The UI and the engine each
 * set where to read it. Here, not in the provider, so setting it does not load the providers.
 */
let source: () => string | undefined = () => undefined;
export function setOwnDidSource(read: () => string | undefined): void { source = read; }
export const ownDid = (): string | undefined => source();
