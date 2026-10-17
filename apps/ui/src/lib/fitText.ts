type Segmenter = { segment(text: string): Iterable<{ segment: string }> };
const SegmenterCtor = (globalThis as { Intl?: { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter } }).Intl?.Segmenter;
const graphemes = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : null;
const splitGraphemes = (s: string) => graphemes ? Array.from(graphemes.segment(s), (g) => g.segment) : [...s];
const lowSurrogate = (s: string, i: number) => { const c = s.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** What a field with a limit keeps of `value`: as many whole characters (graphemes, never half an emoji) as `fits` takes. */
export function fitText(value: string, fits: (s: string) => boolean): string {
  if (fits(value)) return value;
  let kept = "";
  for (const part of splitGraphemes(value)) {
    if (!fits(kept + part)) break;
    kept += part;
  }
  return kept;
}

/**
 * A change to a field with a limit (`fits`), kept the way a text field with `maxLength` does: what was typed or pasted
 * goes in at the caret as far as it fits, the rest of it is left out, and the text around it and the caret stay where
 * they were. Cutting the new value's end instead dropped the text's last character, threw the caret to the end and cut
 * what was typed after there (agents#1097). `caret`: where the field's caret is after the change (`selectionStart`).
 */
export function fitTextEdit(before: string, after: string, caret: number | null, fits: (s: string) => boolean): { value: string; caret: number } {
  if (fits(after)) return { value: after, caret: caret ?? after.length };
  // The text before and after the change, in both: what lies between in `after` is what was put in.
  const end = Math.max(0, Math.min(caret ?? after.length, after.length));
  let head = 0;
  while (head < before.length && head < end && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - end && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // Never between the two halves of a character.
  while (head > 0 && lowSurrogate(after, head)) head--;
  while (tail > 0 && lowSurrogate(after, after.length - tail)) tail--;
  const start = after.slice(0, head), rest = after.slice(after.length - tail), put = after.slice(head, after.length - tail);
  if (!fits(start + rest)) { const whole = fitText(after, fits); return { value: whole, caret: whole.length }; }
  let kept = "";
  for (const part of splitGraphemes(put)) {
    if (!fits(start + kept + part + rest)) break;
    kept += part;
  }
  return { value: start + kept + rest, caret: start.length + kept.length };
}
