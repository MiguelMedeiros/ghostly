import widths from "./shot-widths.json";

/**
 * The `srcset` of an app screenshot (public/screenshots/current). The file itself is the capture, 2× the app's
 * window (2560 wide) or phone (780); the narrower ones stand beside it as `<name>-<width>.webp`, written by
 * scripts/capture/widths.mjs. With `sizes`, a browser takes the one that fits the width the picture is drawn at.
 */
export function shotSrcSet(src: string, kind: keyof typeof widths): string {
  const full = Math.max(...widths[kind]);
  return widths[kind].map((w) => `${w === full ? src : src.replace(/\.webp$/, `-${w}.webp`)} ${w}w`).join(", ");
}
