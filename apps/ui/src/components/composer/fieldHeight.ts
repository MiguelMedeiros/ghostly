import { useEffect, type RefObject } from "react";

/** The composer's field grows with its text up to this height, then scrolls. */
export const FIELD_MAX_HEIGHT = 120;
/**
 * And to no more than this share of what is visible: a phone on its side with the keyboard up leaves about 150px, and
 * a field of 120px pushed the composer's Send, + and emoji buttons under the keyboard. Upright, a third of what the
 * keyboard leaves (400px and more) is past 120px, so nothing changes there.
 */
const FIELD_SHARE_OF_VIEW = 1 / 3;

/** How tall the field may grow now: `FIELD_MAX_HEIGHT`, or a third of the visible height where that is less. */
export function fieldMaxHeight(): number {
  const visible = window.visualViewport?.height ?? window.innerHeight;
  return visible > 0 ? Math.min(FIELD_MAX_HEIGHT, Math.floor(visible * FIELD_SHARE_OF_VIEW)) : FIELD_MAX_HEIGHT;
}

/** The text each field was last fitted to: whether it got shorter since. */
const fitted = new WeakMap<HTMLTextAreaElement, { length: number; lines: number }>();

const linesOf = (text: string) => {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
};

/**
 * Fits the composer's field to its text, up to `fieldMaxHeight()`. Measuring by collapsing the field first
 * (`height: auto`) makes the page lay the whole chat out again, on every keystroke: in WebKit that grows with the chat's
 * length. So the field collapses only when its text got shorter while it is taller than one line, and its height is
 * written only when it changes: a keystroke on one line reads the field's height and writes nothing.
 */
export function fitFieldHeight(input: HTMLTextAreaElement): void {
  const text = input.value;
  const was = fitted.get(input);
  const now = { length: text.length, lines: linesOf(text) };
  fitted.set(input, now);
  const shorter = !!was && (now.length < was.length || now.lines < was.lines);
  if (shorter && input.style.height && input.clientHeight > (parseFloat(getComputedStyle(input).minHeight) || 0)) input.style.height = "auto";
  const height = `${Math.min(input.scrollHeight, fieldMaxHeight())}px`;
  if (input.style.height !== height) input.style.height = height;
}

/**
 * Fits the field again when the visible height changes its maximum (the keyboard comes up or goes, the phone turns),
 * not only when its text changes: a draft of five lines written before the keyboard came up kept its 120px.
 */
export function useFieldFitsView(ref: RefObject<HTMLTextAreaElement | null>): void {
  useEffect(() => {
    const viewport: EventTarget = window.visualViewport ?? window;
    let max = fieldMaxHeight();
    const refit = () => {
      const next = fieldMaxHeight();
      if (next === max) return;
      max = next;
      const input = ref.current;
      if (input?.style.height) fitFieldHeight(input);
    };
    viewport.addEventListener("resize", refit);
    return () => viewport.removeEventListener("resize", refit);
  }, [ref]);
}
