/**
 * How far along something is, for the people using it. "Draft" is a separate
 * axis: every WISP is a Draft, whatever its implementation status.
 */
export const LEVELS = [
  "released",
  "development",
  "building",
  "planned",
  "research",
] as const;
export type Level = (typeof LEVELS)[number];

/** The release the site calls public; everything merged after it is "development". */
export { VERSION as RELEASED_VERSION } from "./release";
export const NEXT_VERSION = "0.5.0";
