import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The list keeps its place while it is hidden. On a phone the open chat takes the chat list's place, and the list is
 * `display: none` meanwhile (App.tsx): a browser drops the scroll of a box it does not draw, so Back from a chat opened
 * far down a long list came to the list's top. Where the person last had it is kept from its scrolls while it shows,
 * and it is put back there in the first draw that shows it again, before it is painted.
 */
export function useKeptScroll(box: RefObject<HTMLElement | null>) {
  const kept = useRef<{ el: HTMLElement; top: number; hidden: boolean; stop: () => void } | null>(null);

  // After every draw: the list or the rail is the box, and whether it shows is in the page, not in this hook's inputs.
  useLayoutEffect(() => {
    const el = box.current;
    if (kept.current?.el !== el) {
      kept.current?.stop();
      kept.current = null;
      if (!el) return;
      const keep = () => { if (kept.current && el.clientHeight > 0) kept.current.top = el.scrollTop; };
      el.addEventListener("scroll", keep, { passive: true });
      kept.current = { el, top: el.scrollTop, hidden: el.clientHeight === 0, stop: () => el.removeEventListener("scroll", keep) };
      return;
    }
    const now = kept.current!, shown = el.clientHeight > 0;
    if (shown && now.hidden && now.top > 0 && el.scrollTop === 0) el.scrollTo(0, now.top);
    now.hidden = !shown;
  });

  useEffect(() => () => { kept.current?.stop(); kept.current = null; }, []);
}
