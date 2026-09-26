import { blob } from "./blob";
import { link } from "./links";
import { time } from "./time";
import type { Detector } from "./types";

/**
 * Every inline detector, in order of precedence: where two match at the same place, the earlier one here wins;
 * otherwise the match that starts first does. A new kind of atom is one line here (its look, if it needs one, is
 * one line in src/components/rich/views.ts; without one it shows as the text it matched).
 */
export const DETECTORS: readonly Detector[] = [
  link,
  blob,
  time,
];
