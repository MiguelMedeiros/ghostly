import { readPicture } from "./linkPreviewFetch";

/**
 * A picture link's picture as a bubble can show it. No shell lets a page load a picture from an address a contact
 * chose: the web app's, the extension's and Desktop's `img-src` name the GIF picker's hosts and nothing else, so an
 * `<img>` on any other address stays empty. The app reads the picture itself (lib/linkPreviewFetch.ts) and the bubble
 * shows the `blob:` address of what came.
 */

/** Pictures read this session, so a bubble drawn again (a scroll, a chat opened again) asks nothing twice. */
const read = new Map<string, Promise<string | null>>();
const KEPT = 24;

/** The `blob:` address of `link`'s picture, or null when it cannot be read. Never rejects. */
export function pictureLinkUrl(link: string): Promise<string | null> {
  const known = read.get(link);
  if (known) return known;
  const pending = readPicture(link, new AbortController().signal).then(blob => (blob ? URL.createObjectURL(blob) : null));
  read.set(link, pending);
  while (read.size > KEPT) {
    const [oldest, gone] = read.entries().next().value!;
    read.delete(oldest);
    // A picture already drawn stays drawn: only the address is given back.
    void gone.then(url => { if (url) URL.revokeObjectURL(url); });
  }
  // A failure is not kept: the site may answer next time.
  void pending.then(url => { if (!url && read.get(link) === pending) read.delete(link); });
  return pending;
}

/** Forgets what was read (tests). */
export function forgetPictureLinks(): void { read.clear(); }
