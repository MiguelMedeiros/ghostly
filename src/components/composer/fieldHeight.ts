/** The composer's field grows with its text up to this height, then scrolls. */
export const FIELD_MAX_HEIGHT = 120;

/** The text each field was last fitted to: whether it got shorter since. */
const fitted = new WeakMap<HTMLTextAreaElement, { length: number; lines: number }>();

const linesOf = (text: string) => {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
};

/**
 * Fits the composer's field to its text, up to `FIELD_MAX_HEIGHT`. Measuring by collapsing the field first
 * (`height: auto`) makes the page lay the whole chat out again, on every keystroke: in WebKit that grows with the chat's
 * length. So the field collapses only when its text got shorter while it is taller than one line, and its height is
 * written only when it changes: a keystroke on one line reads the field's height and writes nothing.
 */
export function fitFieldHeight(input: HTMLTextAreaElement): void {
  const text = input.value;
  const was = fitted.get(input);
  const now = { length: text.length, lines: linesOf(text) };
  fitted.set(input, now);
  const shorter = !!was && (now.length < was.length || now.lines < was.lines);
  if (shorter && input.style.height && input.clientHeight > (parseFloat(getComputedStyle(input).minHeight) || 0)) input.style.height = "auto";
  const height = `${Math.min(input.scrollHeight, FIELD_MAX_HEIGHT)}px`;
  if (input.style.height !== height) input.style.height = height;
}
