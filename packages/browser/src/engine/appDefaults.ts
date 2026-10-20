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

/**
 * One app that comes with Ghostly (WISP 1200 § Built-in apps): its publisher's key and its name (its reference), the
 * digest of the signed bundle this build carries, and the public URL that bundle is published at. The URL is what an
 * app card sent in a chat names, and where its revocations and a restored profile's files are read: the copy in the
 * build is never a source a contact could read.
 */
export interface BuiltInApp {
  publisher: string; name: string; digest: string; url: string;
  /** The pinned bundle's own title and tagline, as its manifest says them: what its row shows before the file is read. */
  title: string; tagline: string;
}

/**
 * The apps that come with Ghostly. A short list kept here on purpose, never "everything in the official store": an
 * entry is added with the pin of its bundle in apps/ui/src/assets/apps/built-in.json, which the build reads from the
 * app's own repository (apps/ui/scripts/built-in-apps.mjs); no bundle is kept in this repository.
 *
 * Chess: Ghostly's own publisher key for it (fingerprint odcg w6wj w8dy nqop), version 2.3.1 (`sequence` 5), at the
 * commit of its repository that the official store lists.
 */
export const BUILT_IN_APPS: readonly BuiltInApp[] = [
  {
    publisher: "odcgw6wjw8dynqop84r47jbjcdqossbgrfiejd367e14hgxmjcho", name: "chess",
    digest: "PnrjBRayGNbhfCkjPXmxLpjKYe2_m9Q65_hUPP8BHOc",
    url: "https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-chess@0cbf1acc8fd7a03848f4e2a68cbec8854767ceaa/app.ghostlyapp",
    title: "Chess", tagline: "Play chess with a contact, live in your chat",
  },
];
