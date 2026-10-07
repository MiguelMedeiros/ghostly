/**
 * Ghostly's official store (WISP 1200 § Stores; docs/APPS.md): the repository github.com/MiguelMedeiros/ghostly-store,
 * read at `HEAD` from raw.githubusercontent.com. `HEAD` is right for an index: its signature, `sequence` and `expires`
 * pin the bytes, and the owner signs a new one at least every 80 days (a jsDelivr copy pinned to a commit would never
 * move).
 */
export const DEFAULT_STORE_URL = "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/ghostly-store.json";

/**
 * The official store's public key (z-base32), which every index read from `DEFAULT_STORE_URL` must be signed by. The
 * owner made it offline with tools/scripts/store-keys.sh (fingerprint y379 ia3t 1urw udj8); the private key never leaves
 * the owner's machine. With it set, a new profile starts with the official store.
 */
export const DEFAULT_STORE_KEY: string = "y379ia3t1urwudj8o4w1qwmuwp1mcxyf956b5r7pqup7stce6diy";

/**
 * The stores a new profile starts with (WISP 1200 § Stores: the default store, preloaded and removable), each a URL and
 * the store key it is pinned to. Preloading one makes no request; the first read comes when the person opens the Apps
 * page or once an app is installed.
 */
export const DEFAULT_APP_STORES: readonly { url: string; key: string }[] = DEFAULT_STORE_KEY
  ? [{ url: DEFAULT_STORE_URL, key: DEFAULT_STORE_KEY }]
  : [];
