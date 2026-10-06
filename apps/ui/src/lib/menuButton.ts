import type { KeyboardEvent } from "react";

/**
 * A menu button's arrow keys (WAI-ARIA's menu button): ↓ or ↑ on the closed button opens its menu, which then takes the
 * focus (Menu's `focusFirst`), as Enter and Space do.
 */
export function openOnArrow(open: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    open();
  };
}
