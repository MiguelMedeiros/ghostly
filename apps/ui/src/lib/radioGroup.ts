import type { KeyboardEvent } from "react";

/**
 * The arrow keys of a `role="radiogroup"` (WAI-ARIA radio group): Down and Right go to the next enabled radio, Up and
 * Left to the one before, around the ends, Home and End to the first and last; Right and Left swap in a right-to-left
 * layout. Focus moves, the choice does not: Space or Enter makes it, since choosing may be an action (another
 * connection for a live chat), not one a key held down should repeat. The group has one Tab stop (`radioTabStop`).
 */
export function radioGroupKeys(e: KeyboardEvent<HTMLElement>): void {
  const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
  const forward = e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight");
  const back = e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft");
  if (!forward && !back && e.key !== "Home" && e.key !== "End") return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')];
  if (!radios.length) return;
  e.preventDefault();
  const at = radios.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0
    : e.key === "End" ? radios.length - 1
    : at < 0 ? (forward ? 0 : radios.length - 1)
    : (at + (forward ? 1 : -1) + radios.length) % radios.length;
  radios[next].focus();
}

/** Which of a group's radios is its one Tab stop: the checked one when it can be chosen, else the first that can. */
export function radioTabStop(radios: readonly { checked: boolean; disabled: boolean }[]): number {
  const checked = radios.findIndex(r => r.checked && !r.disabled);
  return checked >= 0 ? checked : radios.findIndex(r => !r.disabled);
}
