/**
 * What is wrong with one field, right under it. The field points at it with `aria-describedby` and carries
 * `aria-invalid`; the floating card (Toast) is what is read out, so this line has no live role of its own.
 * `lib/focus.ts` `focusToRetype` gives the field the focus back, its text selected.
 */
export function FieldError({ id, testId, children }: { id: string; testId?: string; children?: string | null }) {
  if (!children) return null;
  return <p id={id} data-testid={testId} className="mt-1 text-xs text-danger">{children}</p>;
}
