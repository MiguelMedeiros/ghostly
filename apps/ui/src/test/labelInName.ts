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
