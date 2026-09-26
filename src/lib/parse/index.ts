/**
 * The message text parser: `parseMessage` turns text into blocks and segments, `plainText` into a preview, and
 * `DETECTORS` is where other kinds of atoms plug in. See types.ts for the shapes.
 */
export { parseMessage } from "./blocks";
export { tokenizeInline } from "./inline";
export { plainText, SPOILER_PLAIN } from "./plain";
export { DETECTORS } from "./detectors";
export { linkEnd, link } from "./links";
export { blob, BLOB_MIN } from "./blob";
export { time, type TimeData } from "./time";
export { prettyJson } from "./json";
export type { Atom, Block, Detector, ParseContext, Segment, SpanStyle } from "./types";
