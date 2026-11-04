import { IMAGE_LIMITS, imageSize, previewable } from "@ghostly/core";

/**
 * Whether a picture may be decoded here: its own first bytes say a size the chat would draw (`previewable`). A few
 * kilobytes can say gigabytes once decoded (a PNG of 23000 × 23000 is 64 KB), and one whose bytes say no size would be
 * found out only by decoding it. Read before any `createImageBitmap` or `<img>` of a picture the person chose,
 * pasted, dropped or shared. Never rejects.
 */
export async function decodablePicture(blob: Blob): Promise<boolean> {
  try {
    return previewable(imageSize(new Uint8Array(await blob.slice(0, IMAGE_LIMITS.headBytes).arrayBuffer())));
  } catch {
    return false;
  }
}
