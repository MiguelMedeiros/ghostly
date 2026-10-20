import { IMAGE_LIMITS, imageSize, type ImageMeta } from "@ghostly/core";
import { readPicture } from "./linkPreviewFetch";

/**
 * A picture link's picture as a bubble can show it. No shell lets a page load a picture from an address a contact
 * chose: the web app's, the extension's and Desktop's `img-src` name the GIF picker's hosts and nothing else, so an
 * `<img>` on any other address stays empty. The app reads the picture itself (lib/linkPreviewFetch.ts) and the bubble
 * shows the `blob:` address of what came.
 */

/** A picture read: its `blob:` address, and its size as its bytes say it (readPicture draws none that says none). */
export interface PictureRead extends ImageMeta {
  url: string;
}

/** Pictures read this session, so a bubble drawn again (a scroll, a chat opened again) asks nothing twice. */
const read = new Map<string, Promise<PictureRead | null>>();
/** The reads that are done, for a bubble drawn again to show its picture in its first frame, in its own box. */
const done = new Map<string, PictureRead>();
const KEPT = 64;

/** The size `blob`'s bytes say. */
async function sizeOf(blob: Blob): Promise<ImageMeta | undefined> {
  return imageSize(new Uint8Array(await blob.slice(0, IMAGE_LIMITS.headBytes).arrayBuffer()));
}

/** `link`'s picture, or null when it cannot be read. Never rejects. */
export function pictureLinkUrl(link: string): Promise<PictureRead | null> {
  const known = read.get(link);
  if (known) {
    // Used again: the last one to be let go.
    read.delete(link);
    read.set(link, known);
    return known;
  }
  const pending = readPicture(link, new AbortController().signal)
    .then(async blob => {
      const size = blob && await sizeOf(blob);
      if (!blob || !size) return null;
      const picture = { url: URL.createObjectURL(blob), ...size };
      if (read.get(link) === pending) done.set(link, picture);
      return picture;
    })
    .catch(() => null);
  read.set(link, pending);
  while (read.size > KEPT) {
    const [oldest, gone] = read.entries().next().value!;
    read.delete(oldest);
    done.delete(oldest);
    // A picture already drawn stays drawn: only the address is given back.
    void gone.then(picture => { if (picture) URL.revokeObjectURL(picture.url); });
  }
  // A failure is not kept: the site may answer next time.
  void pending.then(picture => { if (!picture && read.get(link) === pending) read.delete(link); });
  return pending;
}

/** `link`'s picture if it was read already, at once (no wait for a promise, so no frame in a placeholder). */
export function pictureLinkRead(link: string): PictureRead | undefined {
  return done.get(link);
}

/** Forgets what was read (tests). */
export function forgetPictureLinks(): void {
  read.clear();
  done.clear();
}
