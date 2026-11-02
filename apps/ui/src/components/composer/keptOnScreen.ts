import { useEffect, type RefObject } from "react";

/** Space kept between what stands above the composer and the top of the visible area. */
const TOP_EDGE = 4;

/**
 * Keeps what stands above the composer (its refusal card, a paste being read, a file being prepared: placed
 * `bottom-full`, so it grows upwards from the composer's top) inside the visible area. On a phone on its side with the
 * keyboard up the card's top was off the screen, its × with it. Where it does not fit it is cut at the top of the
 * visible area and scrolls; where it fits, nothing is written. `content` changes when what it shows does.
 *
 * Its own box is not observed: cutting it would report a resize to the observer that cut it (the "ResizeObserver
 * loop" error). The composer (its offset parent) and its cards are: the field grows, a card's text changes.
 */
export function useKeptOnScreen(ref: RefObject<HTMLElement | null>, content: string | null): void {
  useEffect(() => {
    const element = ref.current;
    if (content === null || !element) return;
    const viewport = window.visualViewport;
    const fit = () => {
      // Its bottom stays at the composer's top: the room is from there up to the top of what is visible.
      const room = Math.max(0, Math.floor(element.getBoundingClientRect().bottom - (viewport?.offsetTop ?? 0) - TOP_EDGE));
      const cut = element.scrollHeight > room;
      const maxHeight = cut ? `${room}px` : "", overflowY = cut ? "auto" : "";
      if (element.style.maxHeight !== maxHeight) element.style.maxHeight = maxHeight;
      if (element.style.overflowY !== overflowY) element.style.overflowY = overflowY;
    };
    fit();
    const target: EventTarget = viewport ?? window;
    target.addEventListener("resize", fit);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined;
    if (element.parentElement) observer?.observe(element.parentElement);
    for (const card of element.children) observer?.observe(card);
    return () => {
      target.removeEventListener("resize", fit);
      observer?.disconnect();
    };
  }, [ref, content]);
}
