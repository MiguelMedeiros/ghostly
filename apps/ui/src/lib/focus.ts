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

/**
 * A plain button at work: busy, not disabled. A disabled one drops the focus to the page, and it stays there when the
 * work is refused. Its click must do nothing while busy; `data-loading` dims it (`data-[loading]:` classes).
 */
export const working = (busy: boolean) => (busy ? ({ "aria-disabled": true, "aria-busy": true, "data-loading": true } as const) : {});

/**
 * The focus is on the page, or on a control that was just disabled (Chromium drops it to the page from there right
 * after), or on one that is only keeping it because it was disabled while it had it (FocusSafeButton): a step that
 * took that control's place takes it.
 */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || (active as HTMLButtonElement).disabled === true || active.hasAttribute("data-held");
}

/**
 * The focus is where nobody can be: lost as `focusLost` says, or on a control no longer on screen. A phone keeps its
 * chat list mounted but hidden under the chat it opened, and the row or New that opened it keeps the focus until the
 * browser moves it to the page, a moment later.
 */
export function focusOffScreen(): boolean {
  if (focusLost()) return true;
  const active = document.activeElement as HTMLElement;
  return !!active.closest("[hidden], [inert]") || !(active.checkVisibility?.() ?? true);
}

/**
 * A step of a dialog replaced the control that had the focus (Next, They match, Add): the focus fell to the page, and
 * the next Tab started from the top of it. It goes to `container`, the step's own content, instead.
 */
export function keepFocusIn(container: HTMLElement | null | undefined) {
  if (!container) return;
  const active = document.activeElement;
  if (!active || active === document.body) container.focus({ preventScroll: true });
}
