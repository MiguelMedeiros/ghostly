/** Networks whose identities have posts and follows to show (the engine's ACTIVITY_READERS), by provider id. */
export const ACTIVITY_NETWORKS: Readonly<Record<string, string>> = { nostr: "Nostr", pubky: "Pubky", atproto: "Bluesky" };
export const hasIdentityActivity = (provider: string) => Object.prototype.hasOwnProperty.call(ACTIVITY_NETWORKS, provider);
