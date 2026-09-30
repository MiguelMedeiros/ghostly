import type { ImageMeta } from "@ghostly/core";

/** The longest a picture is shown on either side, as the bubble always showed it. */
const MAX_EDGE = 330;

/** Width (pixels) and CSS aspect ratio of the box a picture is shown in. */
export interface PictureBox {
  width: number;
  ratio: string;
}

/**
 * The box of a picture of this size: its own proportions, scaled down to fit 330 × 330 and never up. The bubble may
 * be narrower (a phone): the box then shrinks with it, keeping its proportions.
 */
export function pictureBox({ width, height }: ImageMeta): PictureBox {
  const scale = Math.min(1, MAX_EDGE / width, MAX_EDGE / height);
  return { width: Math.max(1, Math.round(width * scale)), ratio: `${width} / ${height}` };
}

/** Where nothing says how large a picture is (an older sender): a box of a usual photo's shape until it is known. */
export const PLACEHOLDER_BOX: PictureBox = { width: 240, ratio: "4 / 3" };

/** Whether a picture as it loaded has the proportions it was said to have (within 2%). */
export function sameShape(said: ImageMeta, shown: ImageMeta): boolean {
  return Math.abs(shown.width / shown.height - said.width / said.height) <= 0.02 * (said.width / said.height);
}

/**
 * Sizes found on this device, by file id, for this run of the app: read from a picture's first bytes when its
 * sender said nothing, or from the picture as it loaded when that differs. A bubble shown again (the chat reopened)
 * has its box at once. Kept small: a few hundred pairs of numbers.
 */
const known = new Map<string, ImageMeta>();
const KEPT = 500;

export function knownPictureSize(id: string): ImageMeta | undefined {
  return known.get(id);
}

export function rememberPictureSize(id: string, size: ImageMeta): void {
  known.delete(id);
  known.set(id, size);
  if (known.size > KEPT) known.delete(known.keys().next().value!);
}
