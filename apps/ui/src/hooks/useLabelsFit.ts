import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * How much of a header gives way so its buttons stay beside the logo: 0 when all of it fits, up to `steps`. The words
 * differ by language ("Join", "Rejoindre") and grow with the text size, so no fixed width can say it: once logo, buttons
 * and `gap` no longer fit in the header, the next step goes (the buttons' words first, then what the header says it
 * gives up next), measured again after each; each comes back once the header is wider than it was when it went. Widths
 * count in the root's text size, so a smaller text brings them back as a wider window does. A new language starts over.
 *
 * `header` holds `logo` and `buttons` side by side; the buttons keep their natural width (they do not shrink).
 */
export function useLabelsFit(header: RefObject<HTMLElement | null>, logo: RefObject<HTMLElement | null>, buttons: RefObject<HTMLElement | null>, language: string, gap = 8, steps = 1): number {
  const [given, setGiven] = useState(0);
  // The header's width, in rem, when each step that has gone went.
  const goneAt = useRef<number[]>([]);
  const [shownFor, setShownFor] = useState(language);
  if (shownFor !== language) {
    setShownFor(language);
    goneAt.current = [];
    setGiven(0);
  }
  useLayoutEffect(() => {
    const box = header.current;
    if (!box) return;
    const check = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const width = box.clientWidth / rem;
      const last = goneAt.current[goneAt.current.length - 1];
      if (last !== undefined && width > last) { goneAt.current.pop(); setGiven(goneAt.current.length); return; }
      if (goneAt.current.length >= steps || !logo.current || !buttons.current) return;
      const style = getComputedStyle(box);
      const room = box.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (logo.current.offsetWidth + buttons.current.offsetWidth + gap > room) {
        goneAt.current.push(width);
        setGiven(goneAt.current.length);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [header, logo, buttons, given, shownFor, gap, steps]);
  return given;
}
