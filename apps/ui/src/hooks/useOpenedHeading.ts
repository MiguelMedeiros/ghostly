import { useEffect, type RefObject } from "react";
import { focusOffScreen } from "../lib/focus";
import { touchOnly } from "../lib/touchOnly";

/**
 * A chat opened on a touch screen: its message field waits for a tap (the keyboard would come up, lib/touchOnly.ts), and
 * the row or New that opened it is gone with the list, so the focus would fall to the page and a screen reader or the
 * keys would start again from its top. The chat's heading takes it instead (`tabIndex={-1}`), as a Settings section's
 * title does on a phone (layout/Page.tsx), without scrolling. `opened` is the chat on screen (null while none is); it
 * changing is an opening. With a mouse or trackpad nothing changes: the message field takes the focus. Never away from
 * something on screen that has it.
 */
export function useOpenedHeading(heading: RefObject<HTMLElement | null>, opened: string | null): void {
  useEffect(() => {
    if (!opened || !touchOnly() || !focusOffScreen()) return;
    heading.current?.focus({ preventScroll: true });
  }, [opened, heading]);
}
