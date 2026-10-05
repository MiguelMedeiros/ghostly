import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Whether a header's buttons keep their words beside the logo. The words differ by language ("Join", "Rejoindre"),
 * so no fixed width can say it: once logo, buttons and `gap` no longer fit in the header, the words go, and they come
 * back once the header is wider than it was then. A new language starts over with the words.
 *
 * `header` holds `logo` and `buttons` side by side; the buttons keep their natural width (they do not shrink).
 */
export function useLabelsFit(header: RefObject<HTMLElement | null>, logo: RefObject<HTMLElement | null>, buttons: RefObject<HTMLElement | null>, language: string, gap = 8): boolean {
  const [fit, setFit] = useState(true);
  // The header's width when the words stopped fitting; null while they fit.
  const stoppedAt = useRef<number | null>(null);
  const [shownFor, setShownFor] = useState(language);
  if (shownFor !== language) {
    setShownFor(language);
    stoppedAt.current = null;
    setFit(true);
  }
  useLayoutEffect(() => {
    const box = header.current;
    if (!box) return;
    const check = () => {
      const width = box.clientWidth;
      if (stoppedAt.current !== null) {
        if (width > stoppedAt.current) { stoppedAt.current = null; setFit(true); }
        return;
      }
      if (!logo.current || !buttons.current) return;
      const style = getComputedStyle(box);
      const room = width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (logo.current.offsetWidth + buttons.current.offsetWidth + gap > room) {
        stoppedAt.current = width;
        setFit(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [header, logo, buttons, fit, shownFor, gap]);
  return fit;
}
