/**
 * Focus a field where it is, without scrolling to it. WebKit (Safari, and the macOS app's web view) ignores
 * `preventScroll` for a text field focused before its first layout, as one is in the effect of the render that
 * mounts it, and scrolls it into view at the next layout. Reading its box first lays it out.
 */
export function focusInPlace(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.getBoundingClientRect();
  el.focus({ preventScroll: true });
}

/** A field that was refused: the focus goes back to it with its text selected, so the person types it again. */
export function focusToRetype(input: HTMLInputElement | null | undefined) {
  if (!input) return;
  input.focus();
  input.select();
}
