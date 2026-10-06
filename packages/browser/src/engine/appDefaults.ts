/**
 * The stores a new profile starts with (WISP 1200 § Stores: the default store, preloaded and removable), set at build
 * time as a URL and the store key it is pinned to. None yet: the default store's repository does not exist, and the
 * owner decides when it is made and signs it with a key held offline. Preloading one makes no request; the first read
 * comes when the person opens the Apps page or once an app is installed.
 */
export const DEFAULT_APP_STORES: readonly { url: string; key: string }[] = [];
