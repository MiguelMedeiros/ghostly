/** A letter of a right-to-left script: Hebrew, Arabic, Syriac, Thaana, N'Ko and the rest of the block, their forms. */
const RIGHT_TO_LEFT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/**
 * The `dir` of a line that may be an error as it came (the engine's English, `problemText`'s "shown as it came"):
 * `auto` when it has no right-to-left letter, so in Arabic "…indexedDB.open." keeps its stop at its end instead of
 * taking the page's direction, which put it at the line's start. A line with a right-to-left letter is the app's own
 * words (or a Hebrew or Arabic error): it keeps the page's direction, since `auto` would turn an Arabic line that
 * starts with a Latin name ("Cashu متوقف…", "{{wallet}}: …") left to right. Anything not a string: the page's.
 */
export function ownDirection(text: unknown): "auto" | undefined {
  return typeof text === "string" && text.trim() !== "" && !RIGHT_TO_LEFT.test(text) ? "auto" : undefined;
}
