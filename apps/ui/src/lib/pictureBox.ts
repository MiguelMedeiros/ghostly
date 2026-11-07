import type { ImageMeta } from "@ghostly/core";

/** The longest a picture is shown on either side, as the bubble always showed it. */
export const MAX_EDGE = 330;
/** The thinnest a box is made, unless the picture itself is thinner. */
const MIN_EDGE = 24;

/** Width (pixels) and CSS aspect ratio of the box a picture is shown in. */
export interface PictureBox {
  width: number;
  ratio: string;
}

/**
 * The box of a picture of this size: its own proportions, scaled down to fit 330 × 330 and never up. The bubble may
 * be narrower (a phone): the box then shrinks with it, keeping its proportions. A very thin one (1 × 65535, as any
 * sender may say) has a box of its own, no thinner than 24 px and no taller or wider than 330, and is shown in it
 * contained: kept to its proportions, the box was 65,535 px tall.
 */
export function pictureBox({ width, height }: ImageMeta): PictureBox {
  const scale = Math.min(1, MAX_EDGE / width, MAX_EDGE / height);
  const minWidth = Math.min(MIN_EDGE, width);
  const minHeight = Math.min(MIN_EDGE, height);
  if (width * scale >= minWidth && height * scale >= minHeight) return { width: Math.round(width * scale), ratio: `${width} / ${height}` };
  const boxWidth = Math.max(minWidth, Math.round(width * scale));
  return { width: boxWidth, ratio: `${boxWidth} / ${Math.max(minHeight, Math.round(height * scale))}` };
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
