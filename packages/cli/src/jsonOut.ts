/**
 * What `JSON.stringify` leaves raw and a terminal may act on: DEL and the C1 controls (CSI, OSC, ST, NEL... in UTF-8),
 * the line and paragraph separators, and the bidi marks, embeddings, overrides and isolates that reorder a line. Only
 * a string holds them, and a peer writes some of those strings (a message's text), so the CLI's output writes them as
 * `\uXXXX`: the same JSON value for every reader, nothing a terminal acts on. What is stored stays whole.
 */
const RAW = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `value` as the JSON the CLI prints: `JSON.stringify`, with `RAW` escaped. */
export function jsonOut(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)?.replace(RAW, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}
