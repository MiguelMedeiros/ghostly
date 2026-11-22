import { engine } from "@ghostly/browser/platform/engine";

/**
 * The picture of each installed app's icon, by reference: read once for its version and shared by every place it shows
 * (each app card in a chat, each row, again when one scrolls back into view). A new version reads its own, and the
 * picture of the one before goes, as does an uninstalled app's (`dropAppIconsExcept`). One that could not be read is
 * asked again where it shows next.
 */
const installedIcons = new Map<string, { digest: string; url: Promise<string | null> }>();

const revoke = (url: Promise<string | null>) => { void url.then((old) => { if (old) URL.revokeObjectURL(old); }, () => {}); };

export function installedIconUrl(ref: string, digest: string): Promise<string | null> {
  const held = installedIcons.get(ref);
  if (held?.digest === digest) return held.url;
  if (held) revoke(held.url);
  const url = engine.call("appFile", { ref, path: "icon.png" })
    .then((bytes) => (bytes.length ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })) : null));
  const entry = { digest, url };
  installedIcons.set(ref, entry);
  url.catch(() => { if (installedIcons.get(ref) === entry) installedIcons.delete(ref); });
  return url;
}

/** Lets go of the picture of every app not in `refs` (the installed list as read): an uninstalled app's icon goes. */
export function dropAppIconsExcept(refs: Iterable<string>): void {
  const keep = new Set(refs);
  for (const [ref, held] of installedIcons) if (!keep.has(ref)) { installedIcons.delete(ref); revoke(held.url); }
}

/** For tests: forget every icon read. */
export function forgetAppIcons(): void {
  dropAppIconsExcept([]);
}
