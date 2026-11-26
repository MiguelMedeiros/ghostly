/**
 * What is wrong with one field, right under it. The field points at it with `aria-describedby` and carries
 * `aria-invalid`; the floating card (Toast) is what is read out, so this line has no live role of its own.
 * `lib/focus.ts` `focusToRetype` gives the field the focus back, its text selected. It may repeat what was typed (a relay
 * address, which has no space to break at): a word too long for the line is broken, or on a phone it ran past the card and the page scrolled sideways.
 */
export function FieldError({ id, testId, children }: { id: string; testId?: string; children?: string | null }) {
  if (!children) return null;
  return <p id={id} data-testid={testId} className="mt-1 text-xs text-danger break-words">{children}</p>;
}
