const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Label in Name (WCAG 2.5.3) as axe-core's `label-content-name-mismatch` reads it: the words a control shows, in their
 * order, one after another in its accessible name. What it shows is its text as the page holds it, an initial in an
 * `aria-hidden` picture included and the pieces joined with nothing between them (so "P" and "Personal" are one word);
 * text drawn by CSS (`content: attr(…)`) is not in it. For `toHaveAccessibleName`.
 */
export function shownInName(control: Element): RegExp {
  const shown = (control.textContent ?? "").match(WORD) ?? [];
  if (!shown.length) return /^/;
  const escaped = shown.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped.join("[^\\p{L}\\p{N}]+")}(?:$|[^\\p{L}\\p{N}])`, "iu");
}

type Segmenter = { segment(text: string): Iterable<{ segment: string }> };
const SEGMENTER = new (Intl as unknown as { Segmenter: new (locale: undefined, options: { granularity: "word" }) => Segmenter }).Segmenter(undefined, { granularity: "word" });

/** A text's words as axe-core cuts them: NFKD, no parentheticals, non-letters as spaces, then words by `Intl.Segmenter` (so CJK too). */
function words(text: string): string[] {
  let plain = text.toLowerCase().normalize("NFKD");
  for (let previous = ""; previous !== plain;) [previous, plain] = [plain, plain.replace(/\([^()]*\)/g, "")];
  return [...SEGMENTER.segment(plain.replace(/[^\p{L}\p{N}]/gu, " "))].map(({ segment }) => segment.trim()).filter(Boolean);
}

/** Whether a name holds a shown label's words, in order and one after another, as `label-content-name-mismatch` checks it. */
export function labelInName(label: string, name: string): boolean {
  const shown = words(label);
  const named = words(name);
  return named.some((_, start) => shown.every((word, i) => named[start + i] === word));
}
