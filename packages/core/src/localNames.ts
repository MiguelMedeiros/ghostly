/**
 * Names only a local network answers (RFC 6762, RFC 8375, ICANN's .internal, and the usual router and company ones).
 * The same list as apps/ui/src/lib/localHost.ts and Desktop's apps/desktop/src/local_names.rs (a test there pins them).
 */
export const LOCAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "home.arpa", "localdomain", "intranet", "corp"] as const;

/** Whether a lowercase host with no trailing dot is one of `LOCAL_SUFFIXES` or under one. */
export const underLocalSuffix = (host: string): boolean => LOCAL_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`));
